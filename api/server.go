package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"speedplane/model"
	"speedplane/scheduler"
	"speedplane/storage"
)

// RunFunc is a function that executes a speedtest without progress updates.
type RunFunc func(ctx context.Context) (*model.SpeedtestResult, error)

// RunWithProgressFunc is a function that executes a speedtest with progress callbacks.
type RunWithProgressFunc func(ctx context.Context, progress func(stage string, message string)) (*model.SpeedtestResult, error)

type progressUpdate struct {
	Stage   string `json:"stage"`
	Message string `json:"message"`
	Time    string `json:"time"`
}

type progressTracker struct {
	mu       sync.RWMutex
	sessions map[string]chan progressUpdate
}

func newProgressTracker() *progressTracker {
	return &progressTracker{
		sessions: make(map[string]chan progressUpdate),
	}
}

func (pt *progressTracker) createSession(id string) chan progressUpdate {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	ch := make(chan progressUpdate, 10)
	pt.sessions[id] = ch
	return ch
}

func (pt *progressTracker) getSession(id string) (chan progressUpdate, bool) {
	pt.mu.RLock()
	defer pt.mu.RUnlock()
	ch, ok := pt.sessions[id]
	return ch, ok
}

func (pt *progressTracker) removeSession(id string) {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	if ch, ok := pt.sessions[id]; ok {
		close(ch)
		delete(pt.sessions, id)
	}
}

// Server provides HTTP API endpoints for the speedplane application.
type Server struct {
	store        *storage.Store
	runSpeedtest RunFunc
	runWithProgress RunWithProgressFunc
	sched        *scheduler.Scheduler
	progress     *progressTracker
	saveConfig   func()
	wsManager    *WSConnectionManager
}

// NewServer creates a new API server with the given dependencies.
func NewServer(store *storage.Store, runFn RunFunc, runWithProgressFn RunWithProgressFunc, sched *scheduler.Scheduler, saveConfig func()) *Server {
	return &Server{
		store:          store,
		runSpeedtest:   runFn,
		runWithProgress: runWithProgressFn,
		sched:          sched,
		progress:       newProgressTracker(),
		saveConfig:     saveConfig,
		wsManager:      NewWSConnectionManager(),
	}
}

// Register registers all API routes with the given HTTP mux.
func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/summary", s.handleSummary)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/results/", s.handleResultByID)
	mux.HandleFunc("/api/chart-data", s.handleChartData)
	mux.HandleFunc("/api/run", s.handleRun)
	mux.HandleFunc("/api/run/stream", s.handleRunStream)
	mux.HandleFunc("/api/run/progress/", s.handleRunProgress)
	mux.HandleFunc("/api/schedules", s.handleSchedules)
	mux.HandleFunc("/api/schedules/", s.handleScheduleByID)
	mux.HandleFunc("/api/next-run", s.handleNextRun)
	mux.HandleFunc("/api/export/history.json", s.handleExportHistoryJSON)
	mux.HandleFunc("/api/export/history.csv", s.handleExportHistoryCSV)
	mux.HandleFunc("/api/export/current.json", s.handleExportCurrentJSON)
	mux.HandleFunc("/api/export/current.csv", s.handleExportCurrentCSV)
	mux.HandleFunc("/ws", s.handleWebSocket)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := map[string]string{"status": "ok"}
	writeJSON(w, http.StatusOK, resp)
}

// ---------- summary / history ----------

type aggregate struct {
	Count            int     `json:"count"`
	AvgDownloadMbps  float64 `json:"avg_download_mbps"`
	AvgUploadMbps    float64 `json:"avg_upload_mbps"`
	AvgPingMs        float64 `json:"avg_ping_ms"`
	AvgJitterMs      float64 `json:"avg_jitter_ms"`
	AvgPacketLossPct float64 `json:"avg_packet_loss_pct"`
}

type summaryResponse struct {
	Latest   *model.SpeedtestResult `json:"latest,omitempty"`
	Averages map[string]aggregate   `json:"averages"`
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := now.AddDate(0, 0, -30)

	results, err := s.store.ListResults(from, now)
	if err != nil {
		http.Error(w, "failed to load results", http.StatusInternalServerError)
		return
	}

	var latest *model.SpeedtestResult
	if len(results) > 0 {
		tmp := results[len(results)-1]
		latest = &tmp
	}

	resp := summaryResponse{
		Latest:   latest,
		Averages: computeAggregates(results, now),
	}
	writeJSON(w, http.StatusOK, resp)
}

func computeAggregates(results []model.SpeedtestResult, now time.Time) map[string]aggregate {
	loc := now.Location()
	startToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	endToday := startToday.AddDate(0, 0, 1)

	windows := []struct {
		name string
		from time.Time
		to   time.Time
	}{
		{"today", startToday, endToday},
		{"yesterday", startToday.AddDate(0, 0, -1), startToday},
		{"last2days", startToday.AddDate(0, 0, -2), endToday},
		{"last3days", startToday.AddDate(0, 0, -3), endToday},
		{"last7days", startToday.AddDate(0, 0, -7), endToday},
		{"last30days", startToday.AddDate(0, 0, -30), endToday},
	}

	out := make(map[string]aggregate, len(windows))

	for _, win := range windows {
		var agg aggregate
		for _, r := range results {
			t := r.Timestamp.In(loc)
			if t.Before(win.from) || !t.Before(win.to) {
				continue
			}
			agg.Count++
			agg.AvgDownloadMbps += r.DownloadMbps
			agg.AvgUploadMbps += r.UploadMbps
			agg.AvgPingMs += r.PingMs
			agg.AvgJitterMs += r.JitterMs
			agg.AvgPacketLossPct += r.PacketLossPct
		}
		if agg.Count > 0 {
			c := float64(agg.Count)
			agg.AvgDownloadMbps /= c
			agg.AvgUploadMbps /= c
			agg.AvgPingMs /= c
			agg.AvgJitterMs /= c
			agg.AvgPacketLossPct /= c
		}
		out[win.name] = agg
	}

	return out
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	now := time.Now()
	from := now.AddDate(0, 0, -30)
	to := now

	if v := q.Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "invalid from", http.StatusBadRequest)
			return
		}
		from = t
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "invalid to", http.StatusBadRequest)
			return
		}
		to = t
	}

	results, err := s.store.ListResults(from, to)
	if err != nil {
		http.Error(w, "failed to load history", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, results)
}

// handleResultByID handles operations on a specific result by ID.
func (s *Server) handleResultByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/results/")
	if id == "" {
		http.NotFound(w, r)
		return
	}

	switch r.Method {
	case http.MethodDelete:
		if err := s.store.DeleteResult(id); err != nil {
			if err.Error() == "result not found" {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "failed to delete result", http.StatusInternalServerError)
			log.Printf("delete result %s: %v", id, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", http.MethodDelete)
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// ---------- run-now ----------

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if s.runSpeedtest == nil {
		http.Error(w, "speedtest runner not configured", http.StatusInternalServerError)
		return
	}

	res, err := s.runSpeedtest(r.Context())
	if err != nil {
		http.Error(w, "speedtest failed", http.StatusInternalServerError)
		log.Printf("run speedtest: %v", err)
		return
	}

	writeJSON(w, http.StatusOK, res)
}

// handleRunStream starts a speedtest with progress streaming via SSE
func (s *Server) handleRunStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if s.runWithProgress == nil {
		http.Error(w, "speedtest runner not configured", http.StatusInternalServerError)
		return
	}

	// Generate session ID
	sessionID := generateID()

	// Set up SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	// Create progress channel
	progressCh := s.progress.createSession(sessionID)
	defer s.progress.removeSession(sessionID)

	// Send initial message with session ID
	fmt.Fprintf(w, "data: %s\n\n", mustJSON(map[string]interface{}{
		"type":      "started",
		"sessionId": sessionID,
		"message":   "Starting speedtest...",
	}))
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	// Run speedtest in goroutine
	ctx := r.Context()
	resultCh := make(chan struct {
		result *model.SpeedtestResult
		err    error
	}, 1)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				resultCh <- struct {
					result *model.SpeedtestResult
					err    error
				}{nil, fmt.Errorf("panic: %v", r)}
			}
		}()

		progressFn := func(stage string, message string) {
			select {
			case progressCh <- progressUpdate{
				Stage:   stage,
				Message: message,
				Time:    time.Now().UTC().Format(time.RFC3339),
			}:
			case <-ctx.Done():
			}
		}

		result, err := s.runWithProgress(ctx, progressFn)
		resultCh <- struct {
			result *model.SpeedtestResult
			err    error
		}{result, err}
		close(progressCh)
	}()

	// Stream progress updates
	for {
		select {
		case <-ctx.Done():
			return
		case update, ok := <-progressCh:
			if !ok {
				// Channel closed, get final result
				final := <-resultCh
				if final.err != nil {
					fmt.Fprintf(w, "data: %s\n\n", mustJSON(map[string]interface{}{
						"type":    "error",
						"message": final.err.Error(),
					}))
				} else if final.result != nil {
					fmt.Fprintf(w, "data: %s\n\n", mustJSON(map[string]interface{}{
						"type":    "completed",
						"result":  final.result,
						"message": "Speedtest completed successfully",
					}))
				}
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", mustJSON(map[string]interface{}{
				"type":    "progress",
				"stage":   update.Stage,
				"message": update.Message,
				"time":    update.Time,
			}))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}
}

// handleRunProgress provides SSE endpoint for a specific session
func (s *Server) handleRunProgress(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimPrefix(r.URL.Path, "/api/run/progress/")
	if sessionID == "" {
		http.NotFound(w, r)
		return
	}

	progressCh, ok := s.progress.getSession(sessionID)
	if !ok {
		http.NotFound(w, r)
		return
	}

	// Set up SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ctx := r.Context()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case update, ok := <-progressCh:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", mustJSON(map[string]interface{}{
				"type":    "progress",
				"stage":   update.Stage,
				"message": update.Message,
				"time":    update.Time,
			}))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		case <-ticker.C:
			// Keep connection alive
		}
	}
}

func mustJSON(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"error":"marshal error"}`
	}
	return string(b)
}

// handleNextRun returns when the next scheduled speedtest will run
func (s *Server) handleNextRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	info := s.sched.NextRunInfo()
	if info.NextRun == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"next_run": nil,
		})
		return
	}

	now := time.Now()
	remaining := info.NextRun.Sub(now)
	if remaining < 0 {
		remaining = 0
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"next_run":          info.NextRun.UTC().Format(time.RFC3339),
		"remaining":         int64(remaining.Seconds()),
		"interval_duration": int64(info.IntervalDuration.Seconds()),
		"timestamp":         now.Unix(),
	})
}

// ---------- chart data API ----------

type percentileStats struct {
	Min    float64 `json:"min"`
	P10    float64 `json:"p10"`
	Q1     float64 `json:"q1"`
	Median float64 `json:"median"`
	Q3     float64 `json:"q3"`
	P90    float64 `json:"p90"`
	Max    float64 `json:"max"`
}

type chartDataResponse struct {
	Data       []model.SpeedtestResult `json:"data"`
	Stats      *percentileStats         `json:"stats,omitempty"`
	MinValue   float64                  `json:"min_value"`
	MaxValue   float64                  `json:"max_value"`
}

func calculatePercentiles(values []float64) percentileStats {
	if len(values) == 0 {
		return percentileStats{}
	}

	sorted := make([]float64, len(values))
	copy(sorted, values)
	sort.Float64s(sorted)

	percentile := func(p float64) float64 {
		if len(sorted) == 0 {
			return 0
		}
		index := float64(len(sorted)-1) * p
		lower := int(index)
		upper := int(index) + 1
		if upper >= len(sorted) {
			upper = len(sorted) - 1
		}
		weight := index - float64(lower)
		return sorted[lower]*(1-weight) + sorted[upper]*weight
	}

	return percentileStats{
		Min:    sorted[0],
		P10:    percentile(0.1),
		Q1:     percentile(0.25),
		Median: percentile(0.5),
		Q3:     percentile(0.75),
		P90:    percentile(0.9),
		Max:    sorted[len(sorted)-1],
	}
}

func (s *Server) handleChartData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()
	rangeParam := q.Get("range")
	metric := q.Get("metric")

	if rangeParam == "" {
		http.Error(w, "range parameter required (24h, 7d, 30d)", http.StatusBadRequest)
		return
	}
	if metric == "" {
		http.Error(w, "metric parameter required (download, upload, ping, jitter)", http.StatusBadRequest)
		return
	}

	// Calculate date range
	now := time.Now()
	var days int
	switch rangeParam {
	case "24h":
		days = 1
	case "7d":
		days = 7
	case "30d":
		days = 30
	default:
		http.Error(w, "invalid range, must be 24h, 7d, or 30d", http.StatusBadRequest)
		return
	}

	from := now.AddDate(0, 0, -days)
	to := now

	results, err := s.store.ListResults(from, to)
	if err != nil {
		http.Error(w, "failed to load history", http.StatusInternalServerError)
		return
	}

	// Sort by timestamp
	sort.Slice(results, func(i, j int) bool {
		return results[i].Timestamp.Before(results[j].Timestamp)
	})

	// Extract values for the requested metric
	var values []float64
	for _, r := range results {
		var val float64
		switch metric {
		case "download":
			val = r.DownloadMbps
		case "upload":
			val = r.UploadMbps
		case "ping":
			val = r.PingMs
		case "jitter":
			val = r.JitterMs
		default:
			http.Error(w, "invalid metric, must be download, upload, ping, or jitter", http.StatusBadRequest)
			return
		}
		if val >= 0 {
			values = append(values, val)
		}
	}

	// Calculate percentiles
	var stats *percentileStats
	var minVal, maxVal float64

	if len(values) > 0 {
		percentileStats := calculatePercentiles(values)
		stats = &percentileStats
		minVal = percentileStats.Min
		maxVal = percentileStats.Max
	} else {
		minVal = 0
		maxVal = 0
	}

	writeJSON(w, http.StatusOK, chartDataResponse{
		Data:     results,
		Stats:    stats,
		MinValue: minVal,
		MaxValue: maxVal,
	})
}

// ---------- schedules API ----------

func (s *Server) handleSchedules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		schedules := s.sched.Schedules()
		writeJSON(w, http.StatusOK, schedules)

	case http.MethodPost:
		var sc model.Schedule
		if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if sc.Type == "" {
			sc.Type = model.ScheduleInterval
		}
		sc.ID = generateID()
		if sc.Name == "" {
			sc.Name = sc.ID
		}

		cur := s.sched.Schedules()
		cur = append(cur, sc)

		s.sched.SetSchedules(cur)
		if s.saveConfig != nil {
			s.saveConfig()
		}

		writeJSON(w, http.StatusCreated, sc)

	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleScheduleByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/schedules/")
	if id == "" {
		http.NotFound(w, r)
		return
	}

	cur := s.sched.Schedules()

	switch r.Method {
	case http.MethodGet:
		for _, sc := range cur {
			if sc.ID == id {
				writeJSON(w, http.StatusOK, sc)
				return
			}
		}
		http.NotFound(w, r)

	case http.MethodPut:
		var upd model.Schedule
		if err := json.NewDecoder(r.Body).Decode(&upd); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		upd.ID = id

		found := false
		for i := range cur {
			if cur[i].ID == id {
				cur[i] = upd
				found = true
				break
			}
		}
		if !found {
			http.NotFound(w, r)
			return
		}

		s.sched.SetSchedules(cur)
		if s.saveConfig != nil {
			s.saveConfig()
		}
		writeJSON(w, http.StatusOK, upd)

	case http.MethodDelete:
		out := cur[:0]
		found := false
		for _, sc := range cur {
			if sc.ID == id {
				found = true
				continue
			}
			out = append(out, sc)
		}
		if !found {
			http.NotFound(w, r)
			return
		}

		s.sched.SetSchedules(out)
		if s.saveConfig != nil {
			s.saveConfig()
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodPut+", "+http.MethodDelete)
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON error: %v", err)
	}
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// ---------- export API ----------

func (s *Server) handleExportHistoryJSON(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	now := time.Now()
	from := now.AddDate(0, 0, -30)
	to := now

	if v := q.Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err == nil {
			from = t
		}
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err == nil {
			to = t
		}
	}

	results, err := s.store.ListResults(from, to)
	if err != nil {
		http.Error(w, "failed to load history", http.StatusInternalServerError)
		return
	}

	filename := fmt.Sprintf("speedtest-history-%s.json", time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	writeJSON(w, http.StatusOK, results)
}

func (s *Server) handleExportHistoryCSV(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	now := time.Now()
	from := now.AddDate(0, 0, -30)
	to := now

	if v := q.Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err == nil {
			from = t
		}
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err == nil {
			to = t
		}
	}

	results, err := s.store.ListResults(from, to)
	if err != nil {
		http.Error(w, "failed to load history", http.StatusInternalServerError)
		return
	}

	filename := fmt.Sprintf("speedtest-history-%s.csv", time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))

	writer := csv.NewWriter(w)
	defer writer.Flush()

	// Write header
	header := []string{
		"ID", "Timestamp", "Download (Mbps)", "Upload (Mbps)", "Ping (ms)",
		"Jitter (ms)", "Packet Loss (%)", "ISP", "External IP",
		"Server ID", "Server Name", "Server Country",
	}
	if err := writer.Write(header); err != nil {
		log.Printf("write CSV header error: %v", err)
		return
	}

	// Write data rows
	for _, r := range results {
		row := []string{
			r.ID,
			r.Timestamp.Format(time.RFC3339),
			strconv.FormatFloat(r.DownloadMbps, 'f', 2, 64),
			strconv.FormatFloat(r.UploadMbps, 'f', 2, 64),
			strconv.FormatFloat(r.PingMs, 'f', 2, 64),
			strconv.FormatFloat(r.JitterMs, 'f', 2, 64),
			strconv.FormatFloat(r.PacketLossPct, 'f', 2, 64),
			r.ISP,
			r.ExternalIP,
			r.ServerID,
			r.ServerName,
			r.ServerCountry,
		}
		if err := writer.Write(row); err != nil {
			log.Printf("write CSV row error: %v", err)
			return
		}
	}
}

func (s *Server) handleExportCurrentJSON(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := now.AddDate(0, 0, -1)
	to := now

	results, err := s.store.ListResults(from, to)
	if err != nil {
		http.Error(w, "failed to load current data", http.StatusInternalServerError)
		return
	}

	var latest *model.SpeedtestResult
	if len(results) > 0 {
		tmp := results[len(results)-1]
		latest = &tmp
	}

	if latest == nil {
		http.Error(w, "no current data available", http.StatusNotFound)
		return
	}

	filename := fmt.Sprintf("speedtest-current-%s.json", time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	writeJSON(w, http.StatusOK, latest)
}

func (s *Server) handleExportCurrentCSV(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := now.AddDate(0, 0, -1)
	to := now

	results, err := s.store.ListResults(from, to)
	if err != nil {
		http.Error(w, "failed to load current data", http.StatusInternalServerError)
		return
	}

	var latest *model.SpeedtestResult
	if len(results) > 0 {
		tmp := results[len(results)-1]
		latest = &tmp
	}

	if latest == nil {
		http.Error(w, "no current data available", http.StatusNotFound)
		return
	}

	filename := fmt.Sprintf("speedtest-current-%s.csv", time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))

	writer := csv.NewWriter(w)
	defer writer.Flush()

	// Write header
	header := []string{
		"ID", "Timestamp", "Download (Mbps)", "Upload (Mbps)", "Ping (ms)",
		"Jitter (ms)", "Packet Loss (%)", "ISP", "External IP",
		"Server ID", "Server Name", "Server Country",
	}
	if err := writer.Write(header); err != nil {
		log.Printf("write CSV header error: %v", err)
		return
	}

	// Write data row
	row := []string{
		latest.ID,
		latest.Timestamp.Format(time.RFC3339),
		strconv.FormatFloat(latest.DownloadMbps, 'f', 2, 64),
		strconv.FormatFloat(latest.UploadMbps, 'f', 2, 64),
		strconv.FormatFloat(latest.PingMs, 'f', 2, 64),
		strconv.FormatFloat(latest.JitterMs, 'f', 2, 64),
		strconv.FormatFloat(latest.PacketLossPct, 'f', 2, 64),
		latest.ISP,
		latest.ExternalIP,
		latest.ServerID,
		latest.ServerName,
		latest.ServerCountry,
	}
	if err := writer.Write(row); err != nil {
		log.Printf("write CSV row error: %v", err)
		return
	}
}

// ---------- WebSocket handler ----------

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now
	},
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Register connection with manager
	s.wsManager.Add(conn)
	defer s.wsManager.Remove(conn)

	log.Printf("WebSocket client connected from %s", r.RemoteAddr)

	// Send initial status
	if err := s.wsManager.WriteJSON(conn, map[string]interface{}{
		"type":   "status",
		"status": "online",
	}); err != nil {
		log.Printf("WebSocket write error: %v", err)
		return
	}

	// Set up ping/pong
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	// Read goroutine to handle incoming messages and detect disconnects
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("WebSocket error: %v", err)
				}
				return
			}
		}
	}()

	// Main loop: send pings and handle disconnects
	for {
		select {
		case <-done:
			return
		case <-pingTicker.C:
			if err := s.wsManager.WriteJSON(conn, map[string]string{"type": "ping"}); err != nil {
				log.Printf("WebSocket ping error: %v", err)
				return
			}
		}
	}
}

// BroadcastSpeedtestComplete broadcasts when a scheduled speedtest completes
func (s *Server) BroadcastSpeedtestComplete(result *model.SpeedtestResult) {
	s.wsManager.Broadcast(map[string]interface{}{
		"type":    "speedtest-complete",
		"result":  result,
		"message": "New speedtest result available",
	})
}

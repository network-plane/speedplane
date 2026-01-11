package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"speedplane/model"
	"speedplane/scheduler"
	"speedplane/storage"
)

type RunFunc func(ctx context.Context) (*model.SpeedtestResult, error)

type Server struct {
	store        *storage.Store
	runSpeedtest RunFunc
	sched        *scheduler.Scheduler
}

func NewServer(store *storage.Store, runFn RunFunc, sched *scheduler.Scheduler) *Server {
	return &Server{
		store:        store,
		runSpeedtest: runFn,
		sched:        sched,
	}
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/summary", s.handleSummary)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/run", s.handleRun)
	mux.HandleFunc("/api/schedules", s.handleSchedules)
	mux.HandleFunc("/api/schedules/", s.handleScheduleByID)
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

		if err := s.store.SaveSchedules(cur); err != nil {
			http.Error(w, "failed to save schedules", http.StatusInternalServerError)
			return
		}
		s.sched.SetSchedules(cur)

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

		if err := s.store.SaveSchedules(cur); err != nil {
			http.Error(w, "failed to save schedules", http.StatusInternalServerError)
			return
		}
		s.sched.SetSchedules(cur)
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

		if err := s.store.SaveSchedules(out); err != nil {
			http.Error(w, "failed to save schedules", http.StatusInternalServerError)
			return
		}
		s.sched.SetSchedules(out)
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

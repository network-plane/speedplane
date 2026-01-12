// Package speedtest provides functionality to run internet speed tests
// using the speedtest-go library.
package speedtest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	st "github.com/showwin/speedtest-go/speedtest"

	"speedplane/model"
)

// Runner executes speed tests and returns results.
type Runner struct {
	client *st.Speedtest
}

// NewRunner creates a new speedtest runner instance.
func NewRunner() *Runner {
	return &Runner{
		client: st.New(),
	}
}

// Run executes a complete speed test including ping, download, and upload tests.
// It returns a SpeedtestResult with all the test metrics.
func (r *Runner) Run(ctx context.Context) (*model.SpeedtestResult, error) {
	return r.RunWithProgress(ctx, func(_ string, _ string) {})
}

// RunWithProgress executes a speed test with progress callbacks.
// If progress is nil, it behaves like Run().
func (r *Runner) RunWithProgress(ctx context.Context, progress func(stage string, message string)) (*model.SpeedtestResult, error) {
	if progress == nil {
		progress = func(_ string, _ string) {}
	}

	progress("init", "Starting speedtest...")

	// Fetch user info
	progress("user", "Fetching user info...")
	user, err := r.client.FetchUserInfoContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch user info: %w", err)
	}

	// Fetch server list
	progress("servers", "Fetching server list...")
	servers, err := r.client.FetchServerListContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch server list: %w", err)
	}

	if len(servers) == 0 {
		return nil, fmt.Errorf("no servers available")
	}

	progress("servers", fmt.Sprintf("Found %d servers, selecting closest...", len(servers)))
	// Select the first server (closest by default)
	target := servers[0]

	// Test ping/latency
	progress("ping", "Testing ping and latency...")
	err = target.PingTestContext(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("ping test: %w", err)
	}

	// Test download
	progress("download", "Testing download speed...")
	err = target.DownloadTestContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("download test: %w", err)
	}

	// Test upload
	progress("upload", "Testing upload speed...")
	err = target.UploadTestContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("upload test: %w", err)
	}

	progress("processing", "Processing results...")

	// Debug output
	log.Printf("[speedtest] Raw DLSpeed: %.2f (ByteRate), Mbps(): %.2f", float64(target.DLSpeed), target.DLSpeed.Mbps())
	log.Printf("[speedtest] Raw ULSpeed: %.2f (ByteRate), Mbps(): %.2f", float64(target.ULSpeed), target.ULSpeed.Mbps())
	log.Printf("[speedtest] Latency: %v, Jitter: %v", target.Latency, target.Jitter)
	log.Printf("[speedtest] Server: %s (%s) - ID: %s", target.Name, target.Country, target.ID)
	log.Printf("[speedtest] User IP: %s, ISP: %s", user.IP, user.Isp)

	// Convert results using the library's Mbps() method
	// ByteRate represents bits per second, and Mbps() converts to Mbps
	downloadMbps := target.DLSpeed.Mbps()
	uploadMbps := target.ULSpeed.Mbps()

	// Convert latency from Duration to milliseconds
	pingMs := target.Latency.Seconds() * 1000.0
	jitterMs := target.Jitter.Seconds() * 1000.0

	// Get packet loss percentage
	packetLossPct := target.PacketLoss.LossPercent()

	log.Printf("[speedtest] Results - Download: %.2f Mbps, Upload: %.2f Mbps, Ping: %.2f ms, Jitter: %.2f ms, Packet Loss: %.2f%%",
		downloadMbps, uploadMbps, pingMs, jitterMs, packetLossPct)

	// Build result JSON for RawJSON field
	resultJSON := map[string]interface{}{
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"ping": map[string]interface{}{
			"latency": pingMs,
			"jitter":  jitterMs,
		},
		"download": map[string]interface{}{
			"bandwidth": float64(target.DLSpeed),
		},
		"upload": map[string]interface{}{
			"bandwidth": float64(target.ULSpeed),
		},
		"packetLoss": packetLossPct,
		"isp":        user.Isp,
		"interface": map[string]interface{}{
			"externalIp": user.IP,
		},
		"server": map[string]interface{}{
			"id":       target.ID,
			"name":     target.Name,
			"location": fmt.Sprintf("%s, %s", target.Name, target.Country),
			"country":  target.Country,
		},
	}

	rawJSON, err := json.Marshal(resultJSON)
	if err != nil {
		return nil, fmt.Errorf("marshal result json: %w", err)
	}

	res := &model.SpeedtestResult{
		ID:            generateID(),
		Timestamp:     time.Now().UTC(),
		DownloadMbps:  downloadMbps,
		UploadMbps:    uploadMbps,
		PingMs:        pingMs,
		JitterMs:      jitterMs,
		PacketLossPct: packetLossPct,
		ISP:           user.Isp,
		ExternalIP:    user.IP,
		ServerID:      target.ID,
		ServerName:    target.Name,
		ServerCountry: target.Country,
		RawJSON:       rawJSON,
	}

	return res, nil
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

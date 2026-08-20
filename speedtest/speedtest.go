// Package speedtest provides functionality to run internet speed tests
// using the speedtest-go library.
package speedtest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	st "github.com/showwin/speedtest-go/speedtest"

	"speedplane/model"
)

// Options configures how speed tests select servers and run.
type Options struct {
	ServerCity    string
	ServerCountry string
}

// Runner executes speed tests and returns results.
type Runner struct {
	getOpts func() Options
}

// NewRunner creates a runner that reads options via getOpts before each test.
func NewRunner(getOpts func() Options) *Runner {
	return &Runner{getOpts: getOpts}
}

func (r *Runner) opts() Options {
	if r.getOpts != nil {
		return r.getOpts()
	}
	return Options{}
}

// Run executes a complete speed test including ping, download, and upload tests.
func (r *Runner) Run(ctx context.Context) (*model.SpeedtestResult, error) {
	return r.RunWithProgress(ctx, func(_ string, _ string) {})
}

// RunWithProgress executes a speed test with progress callbacks.
func (r *Runner) RunWithProgress(ctx context.Context, progress func(stage string, message string)) (*model.SpeedtestResult, error) {
	if progress == nil {
		progress = func(_ string, _ string) {}
	}

	opts := r.opts()
	city := strings.TrimSpace(opts.ServerCity)
	if city == "" {
		return nil, fmt.Errorf("no server city selected; choose a city in Preferences")
	}
	country := strings.TrimSpace(opts.ServerCountry)
	if country == "" {
		return nil, fmt.Errorf("no server country selected; choose a city and country in Preferences")
	}

	progress("init", "Starting speedtest...")

	client := st.New(st.WithUserConfig(&st.UserConfig{Keyword: city}))

	progress("user", "Fetching user info...")
	user, err := client.FetchUserInfoContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch user info: %w", err)
	}
	progress("user", fmt.Sprintf("Connected from %s (%s)", user.IP, user.Isp))

	progress("servers", fmt.Sprintf("Fetching servers in %s%s...", city, locationLabel(country)))
	servers, err := client.FetchServerListContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch server list: %w", err)
	}
	if len(servers) == 0 {
		return nil, fmt.Errorf("no servers available")
	}

	targets := rankServersByLocation(servers, city, country)
	if len(targets) == 0 {
		return nil, fmt.Errorf("no servers found in %q%s", city, locationLabel(country))
	}

	progress("servers", fmt.Sprintf("Found %d server(s) in %s%s", len(targets), city, locationLabel(country)))

	var lastResult *model.SpeedtestResult
	for attempt, target := range targets {
		if attempt > 0 {
			client.Reset()
			progress("servers", fmt.Sprintf("Trying next server (%d/%d)...", attempt+1, len(targets)))
		}
		progress("servers", fmt.Sprintf("Testing server: %s (%s) [ID %s] - %.1f km",
			target.Name, target.Country, target.ID, target.Distance))

		result, downloadMbps, err := testServer(ctx, user, target, progress)
		if err != nil {
			log.Printf("[speedtest] Server %s (%s) failed: %v", target.Name, target.ID, err)
			continue
		}
		lastResult = result

		if downloadMbps > 0 {
			if attempt > 0 {
				log.Printf("[speedtest] Succeeded on attempt %d with server %s (%s)", attempt+1, target.Name, target.ID)
			}
			return result, nil
		}

		log.Printf("[speedtest] Server %s (%s) reported 0 download, trying next", target.Name, target.ID)
	}

	if lastResult != nil {
		return lastResult, nil
	}

	return nil, fmt.Errorf("no working servers found in %q%s (all failed or returned 0 download)", city, locationLabel(country))
}

func locationLabel(country string) string {
	country = strings.TrimSpace(country)
	if country == "" {
		return ""
	}
	return ", " + country
}

func rankServersByLocation(servers st.Servers, city, country string) st.Servers {
	locationServers := filterByLocation(servers, city, country)
	if len(locationServers) == 0 {
		return nil
	}

	if available := locationServers.Available(); available.Len() > 0 {
		return *available
	}

	return locationServers
}

func filterByLocation(servers st.Servers, city, country string) st.Servers {
	city = strings.TrimSpace(city)
	if city == "" {
		return nil
	}
	country = strings.TrimSpace(country)

	filtered := make(st.Servers, 0, len(servers))
	for _, s := range servers {
		if !strings.EqualFold(strings.TrimSpace(s.Name), city) {
			continue
		}
		if country != "" && !strings.EqualFold(strings.TrimSpace(s.Country), country) {
			continue
		}
		filtered = append(filtered, s)
	}
	return filtered
}

func testServer(
	ctx context.Context,
	user *st.User,
	target *st.Server,
	progress func(stage string, message string),
) (*model.SpeedtestResult, float64, error) {
	progress("ping", "Testing ping and latency...")
	if err := target.PingTestContext(ctx, nil); err != nil {
		return nil, 0, fmt.Errorf("ping test: %w", err)
	}

	pingMs := target.Latency.Seconds() * 1000.0
	jitterMs := target.Jitter.Seconds() * 1000.0
	progress("ping", fmt.Sprintf("Ping: %.1f ms, Jitter: %.1f ms", pingMs, jitterMs))

	progress("download", "Testing download speed...")
	if err := target.DownloadTestContext(ctx); err != nil {
		return nil, 0, fmt.Errorf("download test: %w", err)
	}
	downloadMbps := target.DLSpeed.Mbps()
	progress("download", fmt.Sprintf("Download: %.2f Mbps", downloadMbps))

	if downloadMbps <= 0 {
		return nil, 0, fmt.Errorf("download speed is 0")
	}

	progress("upload", "Testing upload speed...")
	if err := target.UploadTestContext(ctx); err != nil {
		return nil, downloadMbps, fmt.Errorf("upload test: %w", err)
	}
	uploadMbps := target.ULSpeed.Mbps()
	progress("upload", fmt.Sprintf("Upload: %.2f Mbps", uploadMbps))

	progress("processing", "Processing results...")

	log.Printf("[speedtest] Server: %s (%s) - ID: %s, Distance: %.1f km", target.Name, target.Country, target.ID, target.Distance)
	log.Printf("[speedtest] Results - Download: %.2f Mbps, Upload: %.2f Mbps, Ping: %.2f ms",
		downloadMbps, uploadMbps, pingMs)

	packetLossPct := target.PacketLoss.LossPercent()

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
		return nil, downloadMbps, fmt.Errorf("marshal result json: %w", err)
	}

	result := &model.SpeedtestResult{
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

	return result, downloadMbps, nil
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

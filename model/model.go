package model

import (
    "encoding/json"
    "time"
)

// SpeedtestResult represents the results of a speed test execution.
type SpeedtestResult struct {
    ID            string          `json:"id"`
    Timestamp     time.Time       `json:"timestamp"`
    DownloadMbps  float64         `json:"download_mbps"`
    UploadMbps    float64         `json:"upload_mbps"`
    PingMs        float64         `json:"ping_ms"`
    JitterMs      float64         `json:"jitter_ms,omitempty"`
    PacketLossPct float64         `json:"packet_loss_pct,omitempty"`

    ISP           string          `json:"isp,omitempty"`
    ExternalIP    string          `json:"external_ip,omitempty"`
    ServerID      string          `json:"server_id,omitempty"`
    ServerName    string          `json:"server_name,omitempty"`
    ServerCountry string          `json:"server_country,omitempty"`

    RawJSON json.RawMessage `json:"raw_json,omitempty"`
}

// ScheduleType represents the type of schedule for speed tests.
type ScheduleType string

const (
    // ScheduleInterval represents an interval-based schedule (e.g., every hour).
    ScheduleInterval ScheduleType = "interval"
    // ScheduleDaily represents a daily schedule at a specific time.
    ScheduleDaily ScheduleType = "daily"
)

// Schedule defines a scheduled speed test with its configuration.
type Schedule struct {
    ID        string       `json:"id"`
    Name      string       `json:"name"`
    Enabled   bool         `json:"enabled"`
    Type      ScheduleType `json:"type"`
    Every     string       `json:"every,omitempty"`       // Go duration, e.g. "1h"
    TimeOfDay string       `json:"time_of_day,omitempty"` // "HH:MM" local time
}

package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"speedplane/model"
)

// Config is the configuration for the Speedplane server
type Config struct {
    DataDir         string                    `json:"data_dir"`
    ListenAddr      string                    `json:"listen_addr"`
    PublicDashboard bool                      `json:"public_dashboard"`
    Schedules       []model.Schedule          `json:"schedules,omitempty"`
    LastRun         map[string]time.Time      `json:"last_run,omitempty"`
}

// Default returns a Config with default values.
func Default() Config {
    return Config{
        DataDir:         ".",
        ListenAddr:       ":8080",
        PublicDashboard: false,
        Schedules:       nil,
        LastRun:         make(map[string]time.Time),
    }
}

// Load reads and parses the configuration from the data directory.
// If the config file doesn't exist, it returns a default configuration.
func Load(dataDir string) (Config, error) {
    cfgPath := filepath.Join(dataDir, "speedplane.config")

    f, err := os.Open(cfgPath)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            return Default(), nil
        }
        return Config{}, err
    }
    defer f.Close()

    var cfg Config
    if err := json.NewDecoder(f).Decode(&cfg); err != nil {
        return Config{}, err
    }

    def := Default()
    if cfg.DataDir == "" {
        cfg.DataDir = def.DataDir
    }
    if cfg.ListenAddr == "" {
        cfg.ListenAddr = def.ListenAddr
    }
    if cfg.LastRun == nil {
        cfg.LastRun = make(map[string]time.Time)
    }

    return cfg, nil
}

// Save writes the configuration to disk in the data directory.
// The file is written atomically using a temporary file.
func Save(cfg Config) error {
    cfgPath := filepath.Join(cfg.DataDir, "speedplane.config")

    // Create directory if it doesn't exist
    if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
        return err
    }

    tmp := cfgPath + ".tmp"
    f, err := os.Create(tmp)
    if err != nil {
        return err
    }
    defer f.Close()

    enc := json.NewEncoder(f)
    enc.SetIndent("", "  ")
    if err := enc.Encode(cfg); err != nil {
        os.Remove(tmp)
        return err
    }

    if err := f.Close(); err != nil {
        os.Remove(tmp)
        return err
    }

    return os.Rename(tmp, cfgPath)
}

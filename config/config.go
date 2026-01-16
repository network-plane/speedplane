package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"speedplane/model"
)

// Config is the configuration for the Speedplane server
type Config struct {
    DataDir         string                    `json:"data_dir"`
    DBPath          string                    `json:"db_path"`
    ListenAddr      string                    `json:"listen_addr"`
    PublicDashboard bool                      `json:"public_dashboard"`
    SaveManualRuns  bool                      `json:"save_manual_runs"`
    Schedules       []model.Schedule          `json:"schedules,omitempty"`
    LastRun         map[string]time.Time      `json:"last_run,omitempty"`
}

// Default returns a Config with default values.
func Default() Config {
    return Config{
        DataDir:         ".",
        DBPath:          "", // Empty means use {data_dir}/speedplane.results
        ListenAddr:       ":8080",
        PublicDashboard: false,
        SaveManualRuns:  false, // Manual runs don't save to database by default
        Schedules:       nil,
        LastRun:         make(map[string]time.Time),
    }
}

// ResolveConfigPath determines the final config file path based on the provided configPath.
// If configPath is empty, uses current directory + "speedplane.config"
// If configPath is a directory, appends "speedplane.config"
// If configPath is a full path with filename, uses it as-is
func ResolveConfigPath(configPath string) string {
	if configPath == "" {
		wd, _ := os.Getwd()
		return filepath.Join(wd, "speedplane.config")
	}

	// Check if configPath is a directory (ends with separator or is an existing directory)
	if strings.HasSuffix(configPath, string(filepath.Separator)) || strings.HasSuffix(configPath, "/") {
		return filepath.Join(configPath, "speedplane.config")
	}

	// Check if it's an existing directory
	if info, err := os.Stat(configPath); err == nil && info.IsDir() {
		return filepath.Join(configPath, "speedplane.config")
	}

	// Otherwise, treat it as a full path with filename
	return configPath
}

// Load reads and parses the configuration from the specified path.
// configPath can be empty (uses current directory + "speedplane.config"), a directory (appends "speedplane.config"),
// or a full path with filename (uses as-is).
// If the config file doesn't exist, it returns a default configuration.
func Load(configPath string) (Config, error) {
    cfgPath := ResolveConfigPath(configPath)

    f, err := os.Open(cfgPath)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            cfg := Default()
            // Set DataDir to the directory containing where the config file would be
            cfg.DataDir = filepath.Dir(cfgPath)
            return cfg, nil
        }
        return Config{}, err
    }
    defer func() {
        _ = f.Close()
    }()

    var cfg Config
    if err := json.NewDecoder(f).Decode(&cfg); err != nil {
        return Config{}, err
    }

    // Set DataDir to the directory containing the config file
    cfg.DataDir = filepath.Dir(cfgPath)

    def := Default()
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
    defer func() {
        _ = f.Close()
    }()

    enc := json.NewEncoder(f)
    enc.SetIndent("", "  ")
    if err := enc.Encode(cfg); err != nil {
        _ = os.Remove(tmp)
        return err
    }

    if err := f.Close(); err != nil {
        _ = os.Remove(tmp)
        return err
    }

    return os.Rename(tmp, cfgPath)
}

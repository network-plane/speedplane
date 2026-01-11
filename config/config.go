package config

import (
    "encoding/json"
    "errors"
    "os"
    "path/filepath"
)

type Config struct {
    DataDir         string `json:"data_dir"`
    ListenAddr      string `json:"listen_addr"`
    PublicDashboard bool   `json:"public_dashboard"`
}

func Default() Config {
    return Config{
        DataDir:         ".",
        ListenAddr:       ":8080",
        PublicDashboard: false,
    }
}

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

    return cfg, nil
}

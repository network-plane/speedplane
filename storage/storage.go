package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"speedplane/model"
)

// Store provides persistent storage for speedtest results using SQLite.
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// resolveDBPath determines the final database path based on the provided dbPath and dataDir.
// If dbPath is empty, uses dataDir + "speedplane.results"
// If dbPath is a directory, appends "speedplane.results"
// If dbPath is a full path with filename, uses it as-is
func resolveDBPath(dbPath, dataDir string) string {
	if dbPath == "" {
		return filepath.Join(dataDir, "speedplane.results")
	}

	// Check if dbPath is a directory (ends with separator or is an existing directory)
	if strings.HasSuffix(dbPath, string(filepath.Separator)) || strings.HasSuffix(dbPath, "/") {
		return filepath.Join(dbPath, "speedplane.results")
	}

	// Check if it's an existing directory
	if info, err := os.Stat(dbPath); err == nil && info.IsDir() {
		return filepath.Join(dbPath, "speedplane.results")
	}

	// Otherwise, treat it as a full path with filename
	return dbPath
}

// New creates a new Store instance with a SQLite database.
// dbPath can be empty (uses dataDir + "speedplane.results"), a directory (appends "speedplane.results"),
// or a full path with filename (uses as-is).
func New(dbPath, dataDir string) (*Store, error) {
	finalPath := resolveDBPath(dbPath, dataDir)

	// Ensure the directory exists
	dir := filepath.Dir(finalPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}

	db, err := sql.Open("sqlite", finalPath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	store := &Store{db: db}

	// Initialize the database schema
	if err := store.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}

	return store, nil
}

// initSchema creates the results table if it doesn't exist.
func (s *Store) initSchema() error {
	query := `
	CREATE TABLE IF NOT EXISTS results (
		id TEXT PRIMARY KEY,
		timestamp TEXT NOT NULL,
		download_mbps REAL NOT NULL,
		upload_mbps REAL NOT NULL,
		ping_ms REAL NOT NULL,
		jitter_ms REAL,
		packet_loss_pct REAL,
		isp TEXT,
		external_ip TEXT,
		server_id TEXT,
		server_name TEXT,
		server_country TEXT,
		raw_json TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE INDEX IF NOT EXISTS idx_results_timestamp ON results(timestamp);
	`

	_, err := s.db.Exec(query)
	return err
}

// EnsureDirs is a no-op for SQLite storage (kept for compatibility).
func (s *Store) EnsureDirs() error {
	return nil
}

// SaveResult saves a speedtest result to the database.
func (s *Store) SaveResult(res *model.SpeedtestResult) error {
	if res == nil {
		return fmt.Errorf("nil result")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	timestamp := res.Timestamp.UTC().Format(time.RFC3339)
	var rawJSON sql.NullString
	if len(res.RawJSON) > 0 {
		rawJSON = sql.NullString{String: string(res.RawJSON), Valid: true}
	}

	query := `
	INSERT OR REPLACE INTO results (
		id, timestamp, download_mbps, upload_mbps, ping_ms, jitter_ms,
		packet_loss_pct, isp, external_ip, server_id, server_name,
		server_country, raw_json
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	_, err := s.db.Exec(query,
		res.ID,
		timestamp,
		res.DownloadMbps,
		res.UploadMbps,
		res.PingMs,
		res.JitterMs,
		res.PacketLossPct,
		res.ISP,
		res.ExternalIP,
		res.ServerID,
		res.ServerName,
		res.ServerCountry,
		rawJSON,
	)

	return err
}

// CountResults returns the number of results within the specified time range.
func (s *Store) CountResults(from, to time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	fromUTC := from.UTC().Format(time.RFC3339)
	toUTC := to.UTC().Format(time.RFC3339)

	query := `
	SELECT COUNT(*)
	FROM results
	WHERE timestamp >= ? AND timestamp <= ?
	`
	var count int
	err := s.db.QueryRow(query, fromUTC, toUTC).Scan(&count)
	return count, err
}

// ListResults retrieves all speedtest results within the specified time range.
// Results are sorted by timestamp in ascending order.
func (s *Store) ListResults(from, to time.Time) ([]model.SpeedtestResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	fromUTC := from.UTC().Format(time.RFC3339)
	toUTC := to.UTC().Format(time.RFC3339)

	query := `
	SELECT id, timestamp, download_mbps, upload_mbps, ping_ms, jitter_ms,
	       packet_loss_pct, isp, external_ip, server_id, server_name,
	       server_country, raw_json
	FROM results
	WHERE timestamp >= ? AND timestamp <= ?
	ORDER BY timestamp ASC
	`

	rows, err := s.db.Query(query, fromUTC, toUTC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []model.SpeedtestResult
	for rows.Next() {
		var r model.SpeedtestResult
		var timestampStr string
		var rawJSON sql.NullString

		err := rows.Scan(
			&r.ID,
			&timestampStr,
			&r.DownloadMbps,
			&r.UploadMbps,
			&r.PingMs,
			&r.JitterMs,
			&r.PacketLossPct,
			&r.ISP,
			&r.ExternalIP,
			&r.ServerID,
			&r.ServerName,
			&r.ServerCountry,
			&rawJSON,
		)
		if err != nil {
			return nil, err
		}

		// Parse timestamp
		t, err := time.Parse(time.RFC3339, timestampStr)
		if err != nil {
			return nil, fmt.Errorf("parse timestamp: %w", err)
		}
		r.Timestamp = t.UTC()

		// Handle raw JSON
		if rawJSON.Valid {
			r.RawJSON = json.RawMessage(rawJSON.String)
		}

		results = append(results, r)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return results, nil
}

// ListResultsPage retrieves a page of speedtest results within the specified time range.
// Results are sorted by timestamp ascending. limit and offset are 0-based; use 0 for no limit.
func (s *Store) ListResultsPage(from, to time.Time, limit, offset int) ([]model.SpeedtestResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	fromUTC := from.UTC().Format(time.RFC3339)
	toUTC := to.UTC().Format(time.RFC3339)

	query := `
	SELECT id, timestamp, download_mbps, upload_mbps, ping_ms, jitter_ms,
	       packet_loss_pct, isp, external_ip, server_id, server_name,
	       server_country, raw_json
	FROM results
	WHERE timestamp >= ? AND timestamp <= ?
	ORDER BY timestamp ASC
	`
	args := []interface{}{fromUTC, toUTC}
	if limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []model.SpeedtestResult
	for rows.Next() {
		var r model.SpeedtestResult
		var timestampStr string
		var rawJSON sql.NullString

		err := rows.Scan(
			&r.ID,
			&timestampStr,
			&r.DownloadMbps,
			&r.UploadMbps,
			&r.PingMs,
			&r.JitterMs,
			&r.PacketLossPct,
			&r.ISP,
			&r.ExternalIP,
			&r.ServerID,
			&r.ServerName,
			&r.ServerCountry,
			&rawJSON,
		)
		if err != nil {
			return nil, err
		}

		t, err := time.Parse(time.RFC3339, timestampStr)
		if err != nil {
			return nil, fmt.Errorf("parse timestamp: %w", err)
		}
		r.Timestamp = t.UTC()

		if rawJSON.Valid {
			r.RawJSON = json.RawMessage(rawJSON.String)
		}

		results = append(results, r)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return results, nil
}

// DeleteResult deletes a speedtest result by ID.
func (s *Store) DeleteResult(id string) error {
	if id == "" {
		return fmt.Errorf("empty id")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	query := `DELETE FROM results WHERE id = ?`
	result, err := s.db.Exec(query, id)
	if err != nil {
		return err
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	}

	if rowsAffected == 0 {
		return fmt.Errorf("result not found")
	}

	return nil
}

// Close closes the database connection.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Close()
}

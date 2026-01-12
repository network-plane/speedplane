package storage

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"speedplane/model"
)

// Store provides persistent storage for speedtest results.
type Store struct {
	baseDir string
	mu      sync.Mutex
}

// New creates a new Store instance with the given base directory.
func New(baseDir string) *Store {
	return &Store{baseDir: baseDir}
}

// EnsureDirs creates the necessary directory structure for storing results.
func (s *Store) EnsureDirs() error {
	return os.MkdirAll(filepath.Join(s.baseDir, "results"), 0o755)
}

// SaveResult saves a speedtest result to disk, organizing files by date.
func (s *Store) SaveResult(res *model.SpeedtestResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if res == nil {
		return fmt.Errorf("nil result")
	}
	t := res.Timestamp.UTC()
	dir := filepath.Join(
		s.baseDir,
		"results",
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
	)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	filename := fmt.Sprintf("%s.json", t.Format("2006-01-02T15-04-05Z07-00"))
	path := filepath.Join(dir, filename)

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(res)
}

// ListResults retrieves all speedtest results within the specified time range.
// Results are sorted by timestamp in ascending order.
func (s *Store) ListResults(from, to time.Time) ([]model.SpeedtestResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	from = from.UTC()
	to = to.UTC()

	base := filepath.Join(s.baseDir, "results")
	var results []model.SpeedtestResult

	err := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".json" {
			return nil
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		var r model.SpeedtestResult
		if err := json.NewDecoder(f).Decode(&r); err != nil {
			return err
		}
		if r.Timestamp.IsZero() {
			return nil
		}

		t := r.Timestamp.UTC()
		if t.Before(from) || t.After(to) {
			return nil
		}

		results = append(results, r)
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].Timestamp.Before(results[j].Timestamp)
	})

	return results, nil
}

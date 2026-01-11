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

type Store struct {
	baseDir string
	mu      sync.Mutex
}

func New(baseDir string) *Store {
	return &Store{baseDir: baseDir}
}

func (s *Store) EnsureDirs() error {
	return os.MkdirAll(filepath.Join(s.baseDir, "results"), 0o755)
}

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

// ----- schedules -----

func (s *Store) schedulesPath() string {
	return filepath.Join(s.baseDir, "schedules.json")
}

func (s *Store) LoadSchedules() ([]model.Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.schedulesPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var scheds []model.Schedule
	if err := json.Unmarshal(data, &scheds); err != nil {
		return nil, err
	}
	return scheds, nil
}

func (s *Store) SaveSchedules(scheds []model.Schedule) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(s.baseDir, 0o755); err != nil {
		return err
	}

	path := s.schedulesPath()
	tmp := path + ".tmp"

	data, err := json.MarshalIndent(scheds, "", "  ")
	if err != nil {
		return err
	}

	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

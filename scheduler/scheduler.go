package scheduler

import (
	"context"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"speedplane/model"
)

// Runner is a function that executes a speedtest and returns the result.
type Runner func(ctx context.Context) (*model.SpeedtestResult, error)

// OnComplete is a callback function called when a speedtest completes.
type OnComplete func(result *model.SpeedtestResult)

// Scheduler manages scheduled speedtest executions.
type Scheduler struct {
	mu        sync.Mutex
	schedules []model.Schedule
	lastRun   map[string]time.Time
	runner    Runner
	onUpdate  func() // Called when lastRun changes
	onComplete OnComplete
}

// New creates a new Scheduler with the given runner, schedules, and last run times.
func New(runner Runner, initial []model.Schedule, lastRun map[string]time.Time) *Scheduler {
	if lastRun == nil {
		lastRun = make(map[string]time.Time)
	}
	s := &Scheduler{
		schedules: append([]model.Schedule(nil), initial...),
		lastRun:   lastRun,
		runner:    runner,
		onUpdate:  nil,
		onComplete: nil,
	}
	return s
}

// SetOnUpdate sets a callback function that is called when the scheduler's state changes.
func (s *Scheduler) SetOnUpdate(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onUpdate = fn
}

// SetOnComplete sets a callback function that is called when a scheduled speedtest completes.
func (s *Scheduler) SetOnComplete(fn OnComplete) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onComplete = fn
}

// Start begins the scheduler, checking for scheduled speedtests every 30 seconds.
// It runs until the context is cancelled.
func (s *Scheduler) Start(ctx context.Context) {
	go func() {
		log.Println("[scheduler] started")
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				log.Println("[scheduler] stopped")
				return
			case now := <-ticker.C:
				s.check(ctx, now)
			}
		}
	}()
}

func (s *Scheduler) check(ctx context.Context, now time.Time) {
	s.mu.Lock()
	scheds := make([]model.Schedule, len(s.schedules))
	copy(scheds, s.schedules)
	last := make(map[string]time.Time, len(s.lastRun))
	for k, v := range s.lastRun {
		last[k] = v
	}
	s.mu.Unlock()

	for _, sc := range scheds {
		if !sc.Enabled || sc.ID == "" {
			continue
		}
		if !shouldRun(sc, last[sc.ID], now) {
			continue
		}

		id := sc.ID
		go s.runOnce(ctx, id, now)
	}
}

func (s *Scheduler) runOnce(ctx context.Context, id string, now time.Time) {
	result, err := s.runner(ctx)
	if err != nil {
		log.Printf("[scheduler] run %s failed: %v", id, err)
		return
	}
	s.mu.Lock()
	s.lastRun[id] = now
	onUpdate := s.onUpdate
	onComplete := s.onComplete
	s.mu.Unlock()
	if onUpdate != nil {
		onUpdate()
	}
	if onComplete != nil && result != nil {
		onComplete(result)
	}
}

func shouldRun(sc model.Schedule, lastRun time.Time, now time.Time) bool {
	switch sc.Type {
	case model.ScheduleInterval:
		if sc.Every == "" {
			return false
		}
		dur, err := time.ParseDuration(sc.Every)
		if err != nil || dur <= 0 {
			return false
		}
		if lastRun.IsZero() {
			return true
		}
		return now.Sub(lastRun) >= dur

	case model.ScheduleDaily:
		if sc.TimeOfDay == "" {
			return false
		}
		parts := strings.Split(sc.TimeOfDay, ":")
		if len(parts) < 2 {
			return false
		}
		hour, err1 := strconv.Atoi(parts[0])
		min, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil || hour < 0 || hour > 23 || min < 0 || min > 59 {
			return false
		}

		loc := now.Location()
		target := time.Date(now.Year(), now.Month(), now.Day(), hour, min, 0, 0, loc)

		if now.Before(target) {
			return false
		}
		if !lastRun.IsZero() && sameDay(lastRun.In(loc), now) {
			return false
		}
		return true

	default:
		return false
	}
}

func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.YearDay() == b.YearDay()
}

func (s *Scheduler) Schedules() []model.Schedule {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]model.Schedule, len(s.schedules))
	copy(out, s.schedules)
	return out
}

// SetSchedules updates the scheduler's list of schedules.
func (s *Scheduler) SetSchedules(scheds []model.Schedule) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.schedules = make([]model.Schedule, len(scheds))
	copy(s.schedules, scheds)
	// Don't reset lastRun - preserve it
}

// LastRun returns a copy of the map tracking when each schedule last ran.
func (s *Scheduler) LastRun() map[string]time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make(map[string]time.Time, len(s.lastRun))
	for k, v := range s.lastRun {
		result[k] = v
	}
	return result
}

// NextRunInfo contains information about the next scheduled run
type NextRunInfo struct {
	NextRun        *time.Time
	IntervalDuration time.Duration // Full interval duration (for progress calculation)
}

// NextRunTime calculates when the next scheduled speedtest will run
func (s *Scheduler) NextRunTime() *time.Time {
	info := s.NextRunInfo()
	return info.NextRun
}

// NextRunInfo calculates when the next scheduled speedtest will run and returns interval info
func (s *Scheduler) NextRunInfo() NextRunInfo {
	s.mu.Lock()
	scheds := make([]model.Schedule, len(s.schedules))
	copy(scheds, s.schedules)
	last := make(map[string]time.Time, len(s.lastRun))
	for k, v := range s.lastRun {
		last[k] = v
	}
	s.mu.Unlock()

	now := time.Now()
	var nextTime *time.Time
	var intervalDur time.Duration

	for _, sc := range scheds {
		if !sc.Enabled || sc.ID == "" {
			continue
		}

		var candidate time.Time
		var candidateDur time.Duration
		switch sc.Type {
		case model.ScheduleInterval:
			if sc.Every == "" {
				continue
			}
			dur, err := time.ParseDuration(sc.Every)
			if err != nil || dur <= 0 {
				continue
			}
			candidateDur = dur
			lastRun := last[sc.ID]
			if lastRun.IsZero() {
				candidate = now
			} else {
				candidate = lastRun.Add(dur)
				if candidate.Before(now) {
					candidate = now
				}
			}

		case model.ScheduleDaily:
			if sc.TimeOfDay == "" {
				continue
			}
			parts := strings.Split(sc.TimeOfDay, ":")
			if len(parts) < 2 {
				continue
			}
			hour, err1 := strconv.Atoi(parts[0])
			min, err2 := strconv.Atoi(parts[1])
			if err1 != nil || err2 != nil || hour < 0 || hour > 23 || min < 0 || min > 59 {
				continue
			}

			loc := now.Location()
			today := time.Date(now.Year(), now.Month(), now.Day(), hour, min, 0, 0, loc)
			lastRun := last[sc.ID]

			if now.Before(today) {
				candidate = today
			} else {
				// If already passed today or already ran today, schedule for tomorrow
				if !lastRun.IsZero() && sameDay(lastRun.In(loc), now) {
					candidate = today.AddDate(0, 0, 1)
				} else {
					candidate = today.AddDate(0, 0, 1)
				}
			}
			// For daily schedules, interval is 24 hours
			candidateDur = 24 * time.Hour

		default:
			continue
		}

		if nextTime == nil || candidate.Before(*nextTime) {
			nextTime = &candidate
			intervalDur = candidateDur
		}
	}

	return NextRunInfo{
		NextRun:         nextTime,
		IntervalDuration: intervalDur,
	}
}

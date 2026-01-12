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

type Runner func(ctx context.Context) (*model.SpeedtestResult, error)

type Scheduler struct {
	mu        sync.Mutex
	schedules []model.Schedule
	lastRun   map[string]time.Time
	runner    Runner
	onUpdate  func() // Called when lastRun changes
}

func New(runner Runner, initial []model.Schedule, lastRun map[string]time.Time) *Scheduler {
	if lastRun == nil {
		lastRun = make(map[string]time.Time)
	}
	s := &Scheduler{
		schedules: append([]model.Schedule(nil), initial...),
		lastRun:   lastRun,
		runner:    runner,
		onUpdate:  nil,
	}
	return s
}

func (s *Scheduler) SetOnUpdate(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onUpdate = fn
}

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
	_, err := s.runner(ctx)
	if err != nil {
		log.Printf("[scheduler] run %s failed: %v", id, err)
		return
	}
	s.mu.Lock()
	s.lastRun[id] = now
	onUpdate := s.onUpdate
	s.mu.Unlock()
	if onUpdate != nil {
		onUpdate()
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

func (s *Scheduler) SetSchedules(scheds []model.Schedule) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.schedules = make([]model.Schedule, len(scheds))
	copy(s.schedules, scheds)
	// Don't reset lastRun - preserve it
}

func (s *Scheduler) LastRun() map[string]time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make(map[string]time.Time, len(s.lastRun))
	for k, v := range s.lastRun {
		result[k] = v
	}
	return result
}

// NextRunTime calculates when the next scheduled speedtest will run
func (s *Scheduler) NextRunTime() *time.Time {
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

	for _, sc := range scheds {
		if !sc.Enabled || sc.ID == "" {
			continue
		}

		var candidate time.Time
		switch sc.Type {
		case model.ScheduleInterval:
			if sc.Every == "" {
				continue
			}
			dur, err := time.ParseDuration(sc.Every)
			if err != nil || dur <= 0 {
				continue
			}
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

		default:
			continue
		}

		if nextTime == nil || candidate.Before(*nextTime) {
			nextTime = &candidate
		}
	}

	return nextTime
}

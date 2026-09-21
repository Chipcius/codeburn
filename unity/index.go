package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

// Payload is the subset of codeburn's materialized dashboard payload the
// indicator shows. The worker computes it; this only reads it, so the panel
// cannot disagree with the CLI or the dashboard.
type Payload struct {
	Stale   bool `json:"stale"`
	Current struct {
		Cost            float64 `json:"cost"`
		Calls           int     `json:"calls"`
		ProviderDetails []struct {
			ID    string  `json:"id"`
			Label string  `json:"label"`
			Cost  float64 `json:"cost"`
		} `json:"providerDetails"`
		TopModels []struct {
			Name             string  `json:"name"`
			Cost             float64 `json:"cost"`
			EstimatedCostUSD float64 `json:"estimatedCostUSD"`
		} `json:"topModels"`
	} `json:"current"`
}

type Snapshot struct {
	Periods map[string]Payload
	BuiltAt time.Time
}

func cacheDir() string {
	if d := os.Getenv("CODEBURN_CACHE_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache", "codeburn")
}

var versionPattern = regexp.MustCompile(`\.v(\d+)\.db$`)

// indexPath picks the newest schema version present: a schema change renames
// the file, so a hardcoded version would silently read a stale index.
func indexPath() (string, error) {
	matches, _ := filepath.Glob(filepath.Join(cacheDir(), "usage-index.v*.db"))
	best, bestVersion := "", -1
	for _, m := range matches {
		sub := versionPattern.FindStringSubmatch(m)
		if sub == nil {
			continue
		}
		if v, err := strconv.Atoi(sub[1]); err == nil && v > bestVersion {
			best, bestVersion = m, v
		}
	}
	if best == "" {
		return "", errors.New("no usage index yet — run: codeburn index build")
	}
	return best, nil
}

func readSnapshot(periods []string) (*Snapshot, error) {
	path, err := indexPath()
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(2000)")
	if err != nil {
		return nil, fmt.Errorf("cannot open usage index: %w", err)
	}
	defer db.Close()

	snap := &Snapshot{Periods: map[string]Payload{}}
	for _, period := range periods {
		var raw string
		var builtAt int64
		err := db.QueryRow(`SELECT json, built_at FROM ui_payload WHERE key = ?`, "menubar|"+period+"|all").Scan(&raw, &builtAt)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("cannot read usage index: %w", err)
		}
		var p Payload
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			return nil, fmt.Errorf("unreadable %s payload: %w", period, err)
		}
		snap.Periods[period] = p
		if period == periods[0] {
			snap.BuiltAt = time.UnixMilli(builtAt)
		}
	}
	if _, ok := snap.Periods[periods[0]]; !ok {
		return nil, errors.New("the worker has not materialized today's figures yet")
	}
	return snap, nil
}

// minShown is the smallest cost that does not render as $0.00. A provider or
// model with a fraction of a cent of usage is noise in a panel menu.
const minShown = 0.005

func money(v float64) string {
	if v >= 1000 {
		return "$" + commas(int64(v+0.5))
	}
	return fmt.Sprintf("$%.2f", v)
}

func commas(n int64) string {
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
}

func sortedProviders(p Payload) []struct {
	Name string
	Cost float64
} {
	var out []struct {
		Name string
		Cost float64
	}
	for _, d := range p.Current.ProviderDetails {
		if d.Cost < minShown {
			continue
		}
		name := d.Label
		if name == "" {
			name = d.ID
		}
		out = append(out, struct {
			Name string
			Cost float64
		}{name, d.Cost})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Cost > out[j].Cost })
	return out
}

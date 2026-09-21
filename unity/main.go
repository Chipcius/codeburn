// codeburn-indicator shows today's AI coding spend in the Unity 7 panel (and
// any StatusNotifierItem host). It reads the dashboard payloads the
// codeburn-index worker materializes; it never parses a provider store.
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	refreshEvery  = 30 * time.Second
	staleAfter    = 10 * time.Minute
	dashboardAddr = "127.0.0.1:4747"
)

var periods = []string{"today", "month", "30days"}

func main() {
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	repo := filepath.Join(filepath.Dir(exe), "..")
	cli := os.Getenv("CODEBURN_CLI")
	if cli == "" {
		cli = filepath.Join(repo, "dist", "cli.js")
	}

	tray, err := NewTray("codeburn-symbolic", filepath.Join(repo, "gnome", "icons"))
	if err != nil {
		log.Fatal(err)
	}
	defer tray.Close()

	app := &app{tray: tray, cli: cli, quit: make(chan struct{}), wake: make(chan struct{}, 1)}
	app.refresh()

	ticker := time.NewTicker(refreshEvery)
	defer ticker.Stop()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	for {
		select {
		case <-ticker.C:
			app.refresh()
		case <-app.wake:
			app.refresh()
		case <-stop:
			return
		case <-app.quit:
			return
		}
	}
}

type app struct {
	tray     *Tray
	cli      string
	quit     chan struct{}
	wake     chan struct{}
	quitOnce sync.Once
}

func (a *app) actions() []MenuEntry {
	return []MenuEntry{
		{Separator: true},
		{Label: "Open dashboard", Enabled: true, OnClick: a.openDashboard},
		{Label: "Refresh now", Enabled: true, OnClick: func() {
			select {
			case a.wake <- struct{}{}:
			default:
			}
		}},
		{Separator: true},
		{Label: "Quit", Enabled: true, OnClick: func() { a.quitOnce.Do(func() { close(a.quit) }) }},
	}
}

func info(label string) MenuEntry { return MenuEntry{Label: label} }

func (a *app) refresh() {
	snap, err := readSnapshot(periods)
	if err != nil {
		a.tray.SetLabel("CB —", "CB $00,000")
		a.tray.SetMenu(append([]MenuEntry{info(err.Error())}, a.actions()...))
		return
	}

	today := snap.Periods["today"]
	age := time.Since(snap.BuiltAt)
	// The worker flags a payload it served stale, but a stopped worker flags
	// nothing, so judge by age here as well.
	stale := today.Stale || age > staleAfter
	label := money(today.Current.Cost)
	if stale {
		label += " ·"
	}
	a.tray.SetLabel(label, "$00,000.00 ·")

	menu := []MenuEntry{info(fmt.Sprintf("Today         %s   %s calls", money(today.Current.Cost), commas(int64(today.Current.Calls))))}
	for _, p := range []struct{ key, name string }{{"month", "This month"}, {"30days", "30 days"}} {
		if pl, ok := snap.Periods[p.key]; ok {
			menu = append(menu, info(fmt.Sprintf("%-13s %s   %s calls", p.name, money(pl.Current.Cost), commas(int64(pl.Current.Calls)))))
		}
	}

	if providers := sortedProviders(today); len(providers) > 0 {
		menu = append(menu, MenuEntry{Separator: true}, info("By tool, today"))
		for _, p := range providers {
			menu = append(menu, info(fmt.Sprintf("    %-12s %s", p.Name, money(p.Cost))))
		}
	}

	var models []MenuEntry
	for _, m := range today.Current.TopModels {
		if m.Cost < minShown || len(models) == 4 {
			continue
		}
		marker := ""
		if m.EstimatedCostUSD > 0 {
			marker = "~"
		}
		models = append(models, info(fmt.Sprintf("    %-18s %s%s", m.Name, marker, money(m.Cost))))
	}
	if len(models) > 0 {
		menu = append(menu, MenuEntry{Separator: true}, info("Top models, today"))
		menu = append(menu, models...)
	}

	updated := "Updated " + ago(age)
	if age > staleAfter {
		updated += "  (worker may be stopped)"
	}
	menu = append(menu, MenuEntry{Separator: true}, info(updated))
	a.tray.SetMenu(append(menu, a.actions()...))
}

func dashboardUp() bool {
	c, err := net.DialTimeout("tcp", dashboardAddr, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func (a *app) openDashboard() {
	if !dashboardUp() {
		node, err := exec.LookPath("node")
		if err != nil {
			node = "/usr/local/bin/node"
		}
		cmd := exec.Command(node, a.cli, "web", "--no-open")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := cmd.Start(); err != nil {
			log.Printf("start dashboard: %v", err)
			return
		}
		_ = cmd.Process.Release()
		for i := 0; i < 40 && !dashboardUp(); i++ {
			time.Sleep(250 * time.Millisecond)
		}
	}
	_ = exec.Command("xdg-open", "http://"+dashboardAddr+"/").Start()
}

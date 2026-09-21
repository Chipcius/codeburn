package main

import (
	"errors"
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
)

const (
	popoverWidth  = 400
	popoverHeight = 740
	// Unity 7's top panel is 24px; the gap keeps the popover off its shadow.
	panelClearance = 30
	edgeMargin     = 12
)

// The popover is the dashboard's compact page in a chromeless browser window.
// A GTK/WebKit window would need cgo; Chromium's app mode gives a native-looking
// frameless window from a plain exec, and the page is the same React the
// dashboard already ships.
type popover struct {
	mu  sync.Mutex
	cmd *exec.Cmd
}

var chromeCandidates = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"}

func findChrome() (string, error) {
	for _, name := range chromeCandidates {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", errors.New("no Chromium-family browser found for the popover")
}

var primaryGeometry = regexp.MustCompile(`connected primary (\d+)x(\d+)\+(\d+)\+(\d+)`)

// topRight places the popover under the panel at the right edge of the PRIMARY
// monitor. The root window spans every monitor, so its right edge can be on a
// different screen from the panel entirely.
func topRight() (int, int) {
	out, err := exec.Command("xrandr", "--current").Output()
	if err == nil {
		if m := primaryGeometry.FindSubmatch(out); m != nil {
			w, _ := strconv.Atoi(string(m[1]))
			x0, _ := strconv.Atoi(string(m[3]))
			y0, _ := strconv.Atoi(string(m[4]))
			return x0 + w - popoverWidth - edgeMargin, y0 + panelClearance
		}
	}
	return 1920 - popoverWidth - edgeMargin, panelClearance
}

// Toggle opens the popover, or closes it if it is already open — a second click
// on the panel item should dismiss it, as on macOS.
func (p *popover) Toggle(ensureServer func() bool) {
	p.mu.Lock()
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Signal(syscall.SIGTERM)
		p.cmd = nil
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()

	if !ensureServer() {
		log.Print("popover: dashboard server did not start")
		return
	}
	chrome, err := findChrome()
	if err != nil {
		log.Print(err)
		return
	}
	x, y := topRight()
	profile := filepath.Join(cacheDir(), "popover-browser")
	cmd := exec.Command(chrome,
		"--app=http://"+dashboardAddr+"/popover.html",
		// Own profile, so this is a separate browser process that honours the
		// size and position below instead of opening a tab in the user's window.
		"--user-data-dir="+profile,
		fmt.Sprintf("--window-size=%d,%d", popoverWidth, popoverHeight),
		fmt.Sprintf("--window-position=%d,%d", x, y),
		"--class=codeburn-popover",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
	)
	cmd.Stdout, cmd.Stderr = nil, nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		log.Printf("popover: %v", err)
		return
	}
	p.mu.Lock()
	p.cmd = cmd
	p.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		p.mu.Lock()
		if p.cmd == cmd {
			p.cmd = nil
		}
		p.mu.Unlock()
	}()
}

func (p *popover) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Signal(syscall.SIGTERM)
	}
}

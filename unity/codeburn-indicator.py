#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["PyGObject"]
# ///
"""CodeBurn top-bar indicator for Unity 7 (and any AppIndicator panel).

Reads the dashboard payloads the codeburn-index worker materializes into the
usage index. It never parses a provider store and never recomputes a figure:
what it shows is codeburn's own output, so it cannot drift from the CLI or the
dashboard.
"""

import glob
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import AyatanaAppIndicator3 as AppIndicator  # noqa: E402
from gi.repository import GLib, Gtk  # noqa: E402

REFRESH_SECONDS = 30
STALE_AFTER_SECONDS = 10 * 60
DASHBOARD_PORT = 4747
HERE = os.path.dirname(os.path.realpath(__file__))
ICON_DIR = os.path.join(HERE, "..", "gnome", "icons")
CLI = os.environ.get("CODEBURN_CLI") or os.path.join(HERE, "..", "dist", "cli.js")


def cache_dir():
    return os.environ.get("CODEBURN_CACHE_DIR") or os.path.expanduser("~/.cache/codeburn")


def index_path():
    # A schema change renames the file (usage-index.v6.db -> v7), so take the
    # newest version present rather than hardcoding one that goes stale.
    versioned = []
    for path in glob.glob(os.path.join(cache_dir(), "usage-index.v*.db")):
        m = re.search(r"\.v(\d+)\.db$", path)
        if m:
            versioned.append((int(m.group(1)), path))
    return max(versioned)[1] if versioned else None


def read_payloads(periods):
    path = index_path()
    if not path:
        return None, "No usage index yet. Run: codeburn index build"
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error as err:
        return None, f"Cannot open the usage index: {err}"
    try:
        out = {}
        for period in periods:
            row = con.execute(
                "SELECT json, built_at FROM ui_payload WHERE key = ?", (f"menubar|{period}|all",)
            ).fetchone()
            if row:
                out[period] = (json.loads(row[0]), row[1] / 1000)
        return out, None
    except sqlite3.Error as err:
        return None, f"Cannot read the usage index: {err}"
    finally:
        con.close()


def money(value):
    if value >= 1000:
        return f"${value:,.0f}"
    return f"${value:,.2f}"


def ago(seconds):
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)} min ago"
    return f"{int(seconds // 3600)}h ago"


def dashboard_up():
    try:
        with socket.create_connection(("127.0.0.1", DASHBOARD_PORT), timeout=0.3):
            return True
    except OSError:
        return False


class Indicator:
    def __init__(self):
        self.indicator = AppIndicator.Indicator.new(
            "codeburn",
            "codeburn-symbolic",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_icon_theme_path(os.path.realpath(ICON_DIR))
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.indicator.set_title("CodeBurn")
        self.menu = Gtk.Menu()
        self.indicator.set_menu(self.menu)
        self.refresh()
        GLib.timeout_add_seconds(REFRESH_SECONDS, self.refresh)

    def info(self, text):
        item = Gtk.MenuItem(label=text)
        item.set_sensitive(False)
        self.menu.append(item)

    def action(self, text, callback):
        item = Gtk.MenuItem(label=text)
        item.connect("activate", lambda _: callback())
        self.menu.append(item)

    def separator(self):
        self.menu.append(Gtk.SeparatorMenuItem())

    def refresh(self):
        for child in self.menu.get_children():
            self.menu.remove(child)

        payloads, error = read_payloads(["today", "month", "30days"])
        if error or not payloads or "today" not in payloads:
            self.indicator.set_label("CB —", "CB $0,000")
            self.info(error or "The worker has not materialized today's figures yet.")
            self.separator()
            self.action("Quit", Gtk.main_quit)
            self.menu.show_all()
            return True

        today, built_at = payloads["today"]
        cur = today["current"]
        # The worker flags a payload it served stale; also judge it by age here,
        # because a stopped worker never gets the chance to flag anything.
        age = time.time() - built_at
        stale = today.get("stale") is True or age > STALE_AFTER_SECONDS
        self.indicator.set_label(money(cur["cost"]) + (" ·" if stale else ""), "$0,000.00")

        self.info(f"Today      {money(cur['cost'])}   {cur['calls']:,} calls")
        for period, name in (("month", "This month"), ("30days", "30 days")):
            if period in payloads:
                c = payloads[period][0]["current"]
                self.info(f"{name:<10} {money(c['cost'])}   {c['calls']:,} calls")

        providers = [p for p in cur.get("providerDetails", []) if p.get("cost", 0) > 0]
        if providers:
            self.separator()
            self.info("By tool, today")
            for p in sorted(providers, key=lambda p: p["cost"], reverse=True):
                self.info(f"   {p.get('label') or p['id']:<12} {money(p['cost'])}")

        models = [m for m in cur.get("topModels", []) if m.get("cost", 0) > 0][:4]
        if models:
            self.separator()
            self.info("Top models, today")
            for m in models:
                marker = "~" if m.get("estimatedCostUSD", 0) > 0 else ""
                self.info(f"   {m['name']:<18} {marker}{money(m['cost'])}")

        self.separator()
        self.info(f"Updated {ago(age)}" + ("  (worker may be stopped)" if age > STALE_AFTER_SECONDS else ""))
        self.action("Open dashboard", self.open_dashboard)
        self.action("Refresh now", self.refresh)
        self.separator()
        self.action("Quit", Gtk.main_quit)
        self.menu.show_all()
        return True

    def open_dashboard(self):
        if dashboard_up():
            self.launch_browser()
            return
        node = shutil.which("node", path="/usr/local/bin:/usr/bin:/bin") or "node"
        subprocess.Popen(
            [node, CLI, "web", "--no-open"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        # Poll from the GLib loop rather than sleeping here: this runs on the UI
        # thread, and a blocking wait would freeze the whole panel menu.
        self.wait_ticks = 0
        GLib.timeout_add(250, self.poll_dashboard)

    def poll_dashboard(self):
        self.wait_ticks += 1
        if dashboard_up():
            self.launch_browser()
            return False
        return self.wait_ticks < 40

    def launch_browser(self):
        url = f"http://127.0.0.1:{DASHBOARD_PORT}/"
        subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    Indicator()
    Gtk.main()


if __name__ == "__main__":
    main()

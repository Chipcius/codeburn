package main

import (
	"fmt"
	"os"
	"sync"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
)

// A StatusNotifierItem plus a flat com.canonical.dbusmenu, over the session bus
// with no C bindings. Unity 7's indicator-application owns
// org.kde.StatusNotifierWatcher, so an item registered here appears in its panel.
//
// Hand-rolled rather than using fyne.io/systray because the panel text Unity
// draws comes only from XAyatanaLabel (and the XAyatanaNewLabel signal), which
// fyne does not publish — it sets Title, which Unity ignores.

const (
	itemPath  = dbus.ObjectPath("/StatusNotifierItem")
	menuPath  = dbus.ObjectPath("/MenuBar")
	itemIface = "org.kde.StatusNotifierItem"
	menuIface = "com.canonical.dbusmenu"
)

type MenuEntry struct {
	Label     string
	Enabled   bool
	Separator bool
	OnClick   func()
}

type Tray struct {
	conn  *dbus.Conn
	props *prop.Properties

	mu       sync.Mutex
	revision uint32
	entries  []MenuEntry
}

type layout = struct {
	V0 int32
	V1 map[string]dbus.Variant
	V2 []dbus.Variant
}

func NewTray(iconName, iconThemePath string) (*Tray, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("session bus: %w", err)
	}
	t := &Tray{conn: conn}

	name := fmt.Sprintf("org.kde.StatusNotifierItem-%d-1", os.Getpid())
	if _, err := conn.RequestName(name, dbus.NameFlagDoNotQueue); err != nil {
		return nil, fmt.Errorf("request bus name: %w", err)
	}

	t.props, err = prop.Export(conn, itemPath, map[string]map[string]*prop.Prop{
		itemIface: {
			"Category":           {Value: "ApplicationStatus", Emit: prop.EmitTrue},
			"Id":                 {Value: "codeburn", Emit: prop.EmitTrue},
			"Title":              {Value: "CodeBurn", Writable: true, Emit: prop.EmitTrue},
			"Status":             {Value: "Active", Emit: prop.EmitTrue},
			"IconName":           {Value: iconName, Emit: prop.EmitTrue},
			"IconThemePath":      {Value: iconThemePath, Emit: prop.EmitTrue},
			"ItemIsMenu":         {Value: true, Emit: prop.EmitTrue},
			"Menu":               {Value: menuPath, Emit: prop.EmitTrue},
			"XAyatanaLabel":      {Value: "", Writable: true, Emit: prop.EmitTrue},
			"XAyatanaLabelGuide": {Value: "", Writable: true, Emit: prop.EmitTrue},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("export item properties: %w", err)
	}
	if _, err := prop.Export(conn, menuPath, map[string]map[string]*prop.Prop{
		menuIface: {
			"Version":       {Value: uint32(3), Emit: prop.EmitTrue},
			"TextDirection": {Value: "ltr", Emit: prop.EmitTrue},
			"Status":        {Value: "normal", Emit: prop.EmitTrue},
			"IconThemePath": {Value: []string{}, Emit: prop.EmitTrue},
		},
	}); err != nil {
		return nil, fmt.Errorf("export menu properties: %w", err)
	}
	if err := conn.Export((*itemMethods)(t), itemPath, itemIface); err != nil {
		return nil, err
	}
	if err := conn.Export((*menuMethods)(t), menuPath, menuIface); err != nil {
		return nil, err
	}
	for path, iface := range map[dbus.ObjectPath]introspect.Interface{
		itemPath: {Name: itemIface, Properties: t.props.Introspection(itemIface), Methods: introspect.Methods((*itemMethods)(t))},
		menuPath: {Name: menuIface, Methods: introspect.Methods((*menuMethods)(t)), Signals: []introspect.Signal{
			{Name: "LayoutUpdated", Args: []introspect.Arg{{Name: "revision", Type: "u"}, {Name: "parent", Type: "i"}}},
		}},
	} {
		node := &introspect.Node{Name: string(path), Interfaces: []introspect.Interface{introspect.IntrospectData, prop.IntrospectData, iface}}
		if err := conn.Export(introspect.NewIntrospectable(node), path, "org.freedesktop.DBus.Introspectable"); err != nil {
			return nil, err
		}
	}

	watcher := conn.Object("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher")
	if call := watcher.Call("org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem", 0, name); call.Err != nil {
		return nil, fmt.Errorf("no tray host accepted the item (is the panel's indicator service running?): %w", call.Err)
	}
	return t, nil
}

// SetLabel sets the text Unity draws next to the icon. `guide` is the widest
// string expected, so the panel reserves that width and does not jitter as the
// figure changes.
func (t *Tray) SetLabel(label, guide string) {
	t.props.SetMust(itemIface, "XAyatanaLabel", label)
	t.props.SetMust(itemIface, "XAyatanaLabelGuide", guide)
	_ = t.conn.Emit(itemPath, itemIface+".XAyatanaNewLabel", label, guide)
}

func (t *Tray) SetMenu(entries []MenuEntry) {
	t.mu.Lock()
	t.entries = entries
	t.revision++
	rev := t.revision
	t.mu.Unlock()
	_ = t.conn.Emit(menuPath, menuIface+".LayoutUpdated", rev, int32(0))
}

func (t *Tray) Close() { _ = t.conn.Close() }

func (t *Tray) itemLayout(id int32, e MenuEntry) layout {
	props := map[string]dbus.Variant{}
	if e.Separator {
		props["type"] = dbus.MakeVariant("separator")
	} else {
		props["label"] = dbus.MakeVariant(e.Label)
		props["enabled"] = dbus.MakeVariant(e.Enabled)
	}
	return layout{V0: id, V1: props, V2: []dbus.Variant{}}
}

// Menu ids: 0 is the root, entry i is id i+1.
func (t *Tray) lookup(id int32) (MenuEntry, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if id < 1 || int(id) > len(t.entries) {
		return MenuEntry{}, false
	}
	return t.entries[id-1], true
}

type itemMethods Tray

func (t *itemMethods) Activate(x, y int32) *dbus.Error          { return nil }
func (t *itemMethods) SecondaryActivate(x, y int32) *dbus.Error { return nil }
func (t *itemMethods) ContextMenu(x, y int32) *dbus.Error       { return nil }
func (t *itemMethods) Scroll(delta int32, orientation string) *dbus.Error {
	return nil
}

type menuMethods Tray

func (m *menuMethods) GetLayout(parentID int32, depth int32, names []string) (uint32, layout, *dbus.Error) {
	t := (*Tray)(m)
	t.mu.Lock()
	entries := append([]MenuEntry(nil), t.entries...)
	rev := t.revision
	t.mu.Unlock()
	if parentID != 0 {
		if e, ok := t.lookup(parentID); ok {
			return rev, t.itemLayout(parentID, e), nil
		}
		return rev, layout{V0: parentID, V1: map[string]dbus.Variant{}, V2: []dbus.Variant{}}, nil
	}
	root := layout{V0: 0, V1: map[string]dbus.Variant{"children-display": dbus.MakeVariant("submenu")}}
	for i, e := range entries {
		root.V2 = append(root.V2, dbus.MakeVariant(t.itemLayout(int32(i+1), e)))
	}
	return rev, root, nil
}

func (m *menuMethods) GetGroupProperties(ids []int32, names []string) ([]struct {
	V0 int32
	V1 map[string]dbus.Variant
}, *dbus.Error) {
	t := (*Tray)(m)
	var out []struct {
		V0 int32
		V1 map[string]dbus.Variant
	}
	for _, id := range ids {
		if e, ok := t.lookup(id); ok {
			out = append(out, struct {
				V0 int32
				V1 map[string]dbus.Variant
			}{id, t.itemLayout(id, e).V1})
		}
	}
	return out, nil
}

func (m *menuMethods) GetProperty(id int32, name string) (dbus.Variant, *dbus.Error) {
	t := (*Tray)(m)
	if e, ok := t.lookup(id); ok {
		if v, ok := t.itemLayout(id, e).V1[name]; ok {
			return v, nil
		}
	}
	return dbus.MakeVariant(""), nil
}

func (m *menuMethods) Event(id int32, eventID string, data dbus.Variant, timestamp uint32) *dbus.Error {
	if eventID != "clicked" {
		return nil
	}
	if e, ok := (*Tray)(m).lookup(id); ok && e.OnClick != nil && e.Enabled {
		go e.OnClick()
	}
	return nil
}

func (m *menuMethods) EventGroup(events []struct {
	V0 int32
	V1 string
	V2 dbus.Variant
	V3 uint32
}) ([]int32, *dbus.Error) {
	for _, ev := range events {
		_ = m.Event(ev.V0, ev.V1, ev.V2, ev.V3)
	}
	return nil, nil
}

func (m *menuMethods) AboutToShow(id int32) (bool, *dbus.Error) { return false, nil }

func (m *menuMethods) AboutToShowGroup(ids []int32) ([]int32, []int32, *dbus.Error) {
	return nil, nil, nil
}

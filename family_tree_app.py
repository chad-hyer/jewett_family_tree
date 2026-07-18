#!/usr/bin/env python3
"""Jewett Lab Family Tree Maker - GUI application.

Lets you add/edit/delete individuals in an academic family tree (matching
the schema described in README.md) and visualizes the resulting tree.

Run with:  python family_tree_app.py [path/to/data.json]
"""

import csv
import json
import os
import sys
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk

RELATIONSHIP_LABELS = {
    0: "Unknown",
    1: "Undergraduate student",
    2: "Master's student",
    3: "PhD student",
    4: "Postdoctoral scholar",
}
RELATIONSHIP_COLORS = {
    0: "#9e9e9e",
    1: "#4caf50",
    2: "#2196f3",
    3: "#9c27b0",
    4: "#ff9800",
}
RELATIONSHIP_OPTIONS = [f"{k} - {v}" for k, v in RELATIONSHIP_LABELS.items()]
DEFAULT_DATA_PATH = "family_tree_data.json"
EXAMPLE_DATA_PATH = "database_example.json"

X_SPACING = 2.2
Y_SPACING = 1.6
NODE_WIDTH = 1.9
NODE_HEIGHT = 0.55
ZOOM_SCALE = 1.2

# A "leaf cluster" is a person whose children have no children of their own.
# Its children are grouped into columns by relationship and stacked
# vertically instead of spreading out across the x-axis one at a time.
LEAF_COLUMN_SPACING = 1.7
LEAF_ROW_HEIGHT = 0.62
LEAF_NODE_WIDTH = 1.55
LEAF_NODE_HEIGHT = 0.5


def load_data(path):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        content = f.read().strip()
    if not content:
        return []
    data = json.loads(content)
    if not isinstance(data, list):
        raise ValueError("Data file must contain a JSON list of individuals.")
    return data


def save_data(path, people):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(people, f, indent=2)


def coerce_value(value):
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def parse_extra_text(text):
    """Parse a multi-line "key: value" block into a dict."""
    extra = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if ":" not in line:
            raise ValueError(f'Extra field line must be "key: value" - got: "{line}"')
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            raise ValueError(f'Extra field line is missing a key: "{line}"')
        extra[key] = coerce_value(value)
    return extra


def parse_extra_inline(text):
    """Parse a single-line "key: value; key2: value2" string into a dict."""
    extra = {}
    text = text.strip()
    if not text:
        return extra
    for part in text.split(";"):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            raise ValueError(f'Extra field must be "key: value" - got: "{part}"')
        key, value = part.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            raise ValueError(f'Extra field is missing a key: "{part}"')
        extra[key] = coerce_value(value)
    return extra


def extra_to_text(extra):
    return "\n".join(f"{key}: {value}" for key, value in (extra or {}).items())


def suggest_new_id(existing_ids):
    n = 1
    while f"p{n:03d}" in existing_ids:
        n += 1
    return f"p{n:03d}"


def relationship_value(combo_text, default=0):
    return int(combo_text.split(" - ", 1)[0]) if combo_text else default


def parse_relationship_cell(raw):
    """Accept a relationship as a code ("3"), a label ("PhD student"), or "3 - PhD student"."""
    raw = raw.strip()
    if not raw:
        return 0
    if raw.isdigit() and int(raw) in RELATIONSHIP_LABELS:
        return int(raw)
    lowered = raw.lower()
    for code, label in RELATIONSHIP_LABELS.items():
        if lowered == label.lower() or lowered == f"{code} - {label.lower()}":
            return code
    raise ValueError(
        f'Unrecognized relationship "{raw}". Use a number 0-4 or one of: '
        + ", ".join(RELATIONSHIP_LABELS.values())
    )


def bind_relationship_digit_keys(combo, var):
    """Let the user type a digit (0-4) to jump straight to that relationship."""

    def on_key(event):
        if event.char.isdigit():
            code = int(event.char)
            if code in RELATIONSHIP_LABELS:
                var.set(f"{code} - {RELATIONSHIP_LABELS[code]}")
            return "break"

    combo.bind("<Key>", on_key)


def find_descendants(people_by_id, root_id):
    children_map = {}
    for pid, person in people_by_id.items():
        children_map.setdefault(person.get("parent"), []).append(pid)
    result = []
    stack = list(children_map.get(root_id, []))
    while stack:
        node = stack.pop()
        result.append(node)
        stack.extend(children_map.get(node, []))
    return result


def is_ancestor(people_by_id, candidate_id, of_id):
    """Return True if candidate_id is an ancestor of of_id (or equal)."""
    seen = set()
    current = of_id
    while current is not None and current in people_by_id:
        if current == candidate_id:
            return True
        if current in seen:
            break
        seen.add(current)
        current = people_by_id[current].get("parent")
    return False


def compute_default_collapsed(people):
    """Collapse every person whose children are all themselves childless.

    This hides terminal "leaf cluster" branches (e.g. a cohort of students
    with no students of their own) by default, so branches that keep
    growing get visual priority when a tree is first opened.
    """
    children_map = {}
    for p in people:
        parent = p.get("parent")
        if parent is not None:
            children_map.setdefault(parent, []).append(p["id"])
    return {
        pid for pid, kids in children_map.items()
        if kids and all(not children_map.get(k) for k in kids)
    }


class TreeLayout:
    """Computes a compact top-down layout for a forest of trees.

    Nodes in `collapsed` have their descendants hidden entirely (rendered
    as a single badge). A node whose children are all themselves childless
    (a "leaf cluster") has its children grouped into columns by
    relationship and stacked vertically, rather than spread across the
    x-axis one at a time - this keeps large cohorts of students from
    inflating the tree's width.
    """

    def __init__(self, people, collapsed=None):
        self.people_by_id = {p["id"]: p for p in people}
        self.collapsed = collapsed or set()
        self.children_map = {}
        self.roots = []
        self._build()

    def _build(self):
        valid_ids = set(self.people_by_id)
        for person in self.people_by_id.values():
            parent = person.get("parent")
            if parent is None or parent not in valid_ids or is_ancestor(
                self.people_by_id, person["id"], parent
            ):
                self.roots.append(person["id"])
            else:
                self.children_map.setdefault(parent, []).append(person["id"])
        for kids in self.children_map.values():
            kids.sort(key=lambda pid: self.people_by_id[pid].get("name", ""))
        self.roots.sort(key=lambda pid: self.people_by_id[pid].get("name", ""))

    def _is_leaf_cluster(self, pid):
        kids = self.children_map.get(pid)
        return bool(kids) and all(not self.children_map.get(k) for k in kids)

    def _leaf_groups(self, pid):
        grouped = {}
        for child_id in self.children_map[pid]:
            rel = self.people_by_id[child_id].get("relationship", 0)
            grouped.setdefault(rel, []).append(child_id)
        ordered_rels = [r for r in RELATIONSHIP_LABELS if r in grouped]
        ordered_rels += sorted(r for r in grouped if r not in RELATIONSHIP_LABELS)
        return [(r, grouped[r]) for r in ordered_rels]

    def compute(self):
        """Returns (coords, edges, badges, compact_ids, column_labels).

        coords: {person_id: (x, y)} for every visible node.
        edges: [(parent_id, child_id), ...] for every visible connection.
        badges: {person_id: hidden_descendant_count} for collapsed nodes.
        compact_ids: ids rendered as smaller, stacked leaf-cluster boxes.
        column_labels: [(x, y, text), ...] category headers for leaf clusters.
        """
        coords = {}
        edges = []
        badges = {}
        compact_ids = set()
        column_labels = []
        next_x = [0.0]

        def assign(pid, depth):
            y = -depth * Y_SPACING
            kids = self.children_map.get(pid, [])

            if pid in self.collapsed and kids:
                x = next_x[0]
                next_x[0] += X_SPACING
                coords[pid] = (x, y)
                badges[pid] = len(find_descendants(self.people_by_id, pid))
                return x

            if not kids:
                x = next_x[0]
                next_x[0] += X_SPACING
                coords[pid] = (x, y)
                return x

            if self._is_leaf_cluster(pid):
                groups = self._leaf_groups(pid)
                width = len(groups) * LEAF_COLUMN_SPACING
                x_start = next_x[0]
                next_x[0] += width
                cx = x_start + width / 2 - LEAF_COLUMN_SPACING / 2
                coords[pid] = (cx, y)
                child_top_y = y - Y_SPACING
                for col_index, (rel, members) in enumerate(groups):
                    col_x = x_start + col_index * LEAF_COLUMN_SPACING + LEAF_COLUMN_SPACING / 2
                    column_labels.append(
                        (col_x, child_top_y + LEAF_NODE_HEIGHT / 2 + 0.22, RELATIONSHIP_LABELS.get(rel, "Unknown"))
                    )
                    for row_index, member_id in enumerate(members):
                        member_y = child_top_y - row_index * LEAF_ROW_HEIGHT
                        coords[member_id] = (col_x, member_y)
                        compact_ids.add(member_id)
                        edges.append((pid, member_id))
                return cx

            xs = [assign(k, depth + 1) for k in kids]
            for k in kids:
                edges.append((pid, k))
            cx = sum(xs) / len(xs)
            coords[pid] = (cx, y)
            return cx

        for root in self.roots:
            assign(root, 0)

        return coords, edges, badges, compact_ids, column_labels


class VerticalScrolledFrame(ttk.Frame):
    """A scrollable frame; add widgets to `.interior`."""

    def __init__(self, master, height=220, **kwargs):
        super().__init__(master, **kwargs)
        canvas = tk.Canvas(self, borderwidth=0, highlightthickness=0, height=height)
        scrollbar = ttk.Scrollbar(self, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        self.interior = ttk.Frame(canvas)
        window_id = canvas.create_window((0, 0), window=self.interior, anchor="nw")

        def on_interior_configure(_event):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def on_canvas_configure(event):
            canvas.itemconfig(window_id, width=event.width)

        self.interior.bind("<Configure>", on_interior_configure)
        canvas.bind("<Configure>", on_canvas_configure)


class PersonForm(ttk.LabelFrame):
    def __init__(self, master, on_save, on_delete, on_clear, get_people):
        super().__init__(master, text="Individual", padding=10)
        self.on_save = on_save
        self.on_delete = on_delete
        self.on_clear = on_clear
        self.get_people = get_people
        self.editing_id = None

        row = 0
        ttk.Label(self, text="ID").grid(row=row, column=0, sticky="w")
        self.id_var = tk.StringVar()
        self.id_entry = ttk.Entry(self, textvariable=self.id_var)
        self.id_entry.grid(row=row, column=1, sticky="ew", pady=2)

        row += 1
        ttk.Label(self, text="Name").grid(row=row, column=0, sticky="w")
        self.name_var = tk.StringVar()
        ttk.Entry(self, textvariable=self.name_var).grid(row=row, column=1, sticky="ew", pady=2)

        row += 1
        ttk.Label(self, text="Parent").grid(row=row, column=0, sticky="w")
        self.parent_var = tk.StringVar()
        self.parent_combo = ttk.Combobox(self, textvariable=self.parent_var, state="readonly")
        self.parent_combo.grid(row=row, column=1, sticky="ew", pady=2)

        row += 1
        ttk.Label(self, text="Relationship").grid(row=row, column=0, sticky="w")
        self.relationship_var = tk.StringVar()
        self.relationship_combo = ttk.Combobox(
            self, textvariable=self.relationship_var, state="readonly",
            values=RELATIONSHIP_OPTIONS,
        )
        self.relationship_combo.current(0)
        self.relationship_combo.grid(row=row, column=1, sticky="ew", pady=2)

        row += 1
        ttk.Label(self, text="Extra (one \"key: value\" per line)").grid(
            row=row, column=0, columnspan=2, sticky="w", pady=(8, 0)
        )
        row += 1
        self.extra_text = tk.Text(self, height=6, width=30)
        self.extra_text.grid(row=row, column=0, columnspan=2, sticky="nsew", pady=2)

        row += 1
        btn_frame = ttk.Frame(self)
        btn_frame.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        ttk.Button(btn_frame, text="Add / Update", command=self._save).pack(side="left", expand=True, fill="x")
        ttk.Button(btn_frame, text="Delete", command=self._delete).pack(side="left", expand=True, fill="x", padx=4)
        ttk.Button(btn_frame, text="Clear", command=self._clear).pack(side="left", expand=True, fill="x")

        self.columnconfigure(1, weight=1)

    def refresh_parent_options(self, exclude_id=None):
        people = self.get_people()
        options = ["(none)"]
        for p in people:
            if p["id"] == exclude_id:
                continue
            options.append(f'{p["id"]} - {p["name"]}')
        self.parent_combo["values"] = options
        if self.parent_var.get() not in options:
            self.parent_var.set("(none)")

    def load_person(self, person):
        self.editing_id = person["id"]
        self.id_var.set(person["id"])
        self.id_entry.configure(state="disabled")
        self.name_var.set(person.get("name", ""))
        self.refresh_parent_options(exclude_id=person["id"])
        parent = person.get("parent")
        if parent:
            match = next((p for p in self.get_people() if p["id"] == parent), None)
            self.parent_var.set(f'{parent} - {match["name"]}' if match else "(none)")
        else:
            self.parent_var.set("(none)")
        rel = person.get("relationship", 0)
        self.relationship_combo.set(f"{rel} - {RELATIONSHIP_LABELS.get(rel, 'Unknown')}")
        self.extra_text.delete("1.0", "end")
        self.extra_text.insert("1.0", extra_to_text(person.get("extra", {})))

    def set_parent_preset(self, parent_id):
        """Pre-fill the parent field, e.g. after a right-click 'Add Child'."""
        self.refresh_parent_options()
        match = next((p for p in self.get_people() if p["id"] == parent_id), None)
        if match:
            self.parent_var.set(f'{parent_id} - {match["name"]}')

    def _clear(self):
        self.editing_id = None
        self.id_entry.configure(state="normal")
        self.id_var.set(suggest_new_id({p["id"] for p in self.get_people()}))
        self.name_var.set("")
        self.refresh_parent_options()
        self.parent_var.set("(none)")
        self.relationship_combo.current(0)
        self.extra_text.delete("1.0", "end")
        self.on_clear()

    def _delete(self):
        if self.editing_id is None:
            messagebox.showinfo("Delete", "Select an existing individual first.")
            return
        self.on_delete(self.editing_id)

    def _save(self):
        pid = self.id_var.get().strip()
        name = self.name_var.get().strip()
        if not pid:
            messagebox.showerror("Invalid input", "ID is required.")
            return
        if not name:
            messagebox.showerror("Invalid input", "Name is required.")
            return
        existing_ids = {p["id"] for p in self.get_people() if p["id"] != self.editing_id}
        if pid in existing_ids:
            messagebox.showerror("Invalid input", f'ID "{pid}" is already in use.')
            return

        parent_raw = self.parent_var.get()
        parent = None if parent_raw in ("", "(none)") else parent_raw.split(" - ", 1)[0]
        if parent == pid:
            messagebox.showerror("Invalid input", "A person cannot be their own parent.")
            return

        relationship = relationship_value(self.relationship_var.get())

        try:
            extra = parse_extra_text(self.extra_text.get("1.0", "end"))
        except ValueError as e:
            messagebox.showerror("Invalid extra field", str(e))
            return

        person = {
            "id": pid,
            "name": name,
            "parent": parent,
            "relationship": relationship,
            "extra": extra,
        }
        self.on_save(person, is_new=self.editing_id is None)


class QuickAddChildDialog(tk.Toplevel):
    """Small popup for adding a single child from the tree view's right-click menu."""

    def __init__(self, master, parent_person, on_add):
        super().__init__(master)
        self.on_add = on_add
        self.title(f'Add Child of "{parent_person["name"]}"')
        self.resizable(False, False)
        self.transient(master)

        pad = dict(padx=10, pady=4)
        ttk.Label(self, text="Name").grid(row=0, column=0, sticky="w", **pad)
        self.name_var = tk.StringVar()
        name_entry = ttk.Entry(self, textvariable=self.name_var, width=30)
        name_entry.grid(row=0, column=1, sticky="ew", **pad)

        ttk.Label(self, text="Relationship").grid(row=1, column=0, sticky="w", **pad)
        self.relationship_var = tk.StringVar(value=RELATIONSHIP_OPTIONS[0])
        ttk.Combobox(
            self, textvariable=self.relationship_var, state="readonly", values=RELATIONSHIP_OPTIONS
        ).grid(row=1, column=1, sticky="ew", **pad)

        ttk.Label(self, text='Extra ("key: value" per line)').grid(row=2, column=0, columnspan=2, sticky="w", padx=10)
        self.extra_text = tk.Text(self, height=4, width=32)
        self.extra_text.grid(row=3, column=0, columnspan=2, sticky="nsew", padx=10, pady=(0, 4))

        btn_frame = ttk.Frame(self)
        btn_frame.grid(row=4, column=0, columnspan=2, sticky="ew", padx=10, pady=(4, 10))
        ttk.Button(btn_frame, text="Add", command=self._add).pack(side="left", expand=True, fill="x")
        ttk.Button(btn_frame, text="Cancel", command=self.destroy).pack(side="left", expand=True, fill="x", padx=(6, 0))

        self.columnconfigure(1, weight=1)
        name_entry.focus_set()
        self.bind("<Return>", lambda _e: self._add())
        self.bind("<Escape>", lambda _e: self.destroy())

    def _add(self):
        name = self.name_var.get().strip()
        if not name:
            messagebox.showerror("Invalid input", "Name is required.", parent=self)
            return
        try:
            extra = parse_extra_text(self.extra_text.get("1.0", "end"))
        except ValueError as e:
            messagebox.showerror("Invalid extra field", str(e), parent=self)
            return
        relationship = relationship_value(self.relationship_var.get())
        self.on_add(name, relationship, extra)
        self.destroy()


class NodeDetailsWindow(tk.Toplevel):
    """Shows one person's info and lets you bulk-add children via a table."""

    def __init__(self, master, app, person_id):
        super().__init__(master)
        self.app = app
        self.person_id = person_id
        self.rows = []
        self.transient(master)
        self.geometry("640x680")
        self.minsize(560, 420)

        person = self.app.get_person(person_id)
        self.title(f'Details - {person["name"]}')

        # Close is pinned to the very bottom first, so it always stays visible
        # even if the children table above grows tall.
        ttk.Button(self, text="Close", command=self.destroy).pack(side="bottom", pady=(0, 10))

        info_frame = ttk.LabelFrame(self, text="Person Info", padding=10)
        info_frame.pack(side="top", fill="x", padx=10, pady=(10, 6))

        ttk.Label(info_frame, text=f'ID: {person["id"]}').grid(row=0, column=0, columnspan=2, sticky="w")

        ttk.Label(info_frame, text="Name").grid(row=1, column=0, sticky="w", pady=2)
        self.name_var = tk.StringVar(value=person.get("name", ""))
        ttk.Entry(info_frame, textvariable=self.name_var).grid(row=1, column=1, sticky="ew", pady=2)

        parent = person.get("parent")
        parent_person = self.app.get_person(parent) if parent else None
        ttk.Label(info_frame, text="Parent").grid(row=2, column=0, sticky="w", pady=2)
        ttk.Label(info_frame, text=parent_person["name"] if parent_person else "(none - root)").grid(
            row=2, column=1, sticky="w", pady=2
        )

        ttk.Label(info_frame, text="Relationship to parent").grid(row=3, column=0, sticky="w", pady=2)
        self.relationship_var = tk.StringVar()
        rel = person.get("relationship", 0)
        self.relationship_var.set(f"{rel} - {RELATIONSHIP_LABELS.get(rel, 'Unknown')}")
        rel_combo = ttk.Combobox(
            info_frame, textvariable=self.relationship_var, state="readonly", values=RELATIONSHIP_OPTIONS
        )
        rel_combo.grid(row=3, column=1, sticky="ew", pady=2)
        if parent_person is None:
            rel_combo.configure(state="disabled")

        ttk.Label(info_frame, text='Extra ("key: value" per line)').grid(row=4, column=0, columnspan=2, sticky="w", pady=(6, 0))
        self.extra_text = tk.Text(info_frame, height=4)
        self.extra_text.grid(row=5, column=0, columnspan=2, sticky="ew", pady=2)
        self.extra_text.insert("1.0", extra_to_text(person.get("extra", {})))

        info_frame.columnconfigure(1, weight=1)

        self.info_status_var = tk.StringVar()
        info_btn_row = ttk.Frame(info_frame)
        info_btn_row.grid(row=6, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Button(info_btn_row, text="Save Info", command=self._save_info).pack(side="left")
        ttk.Label(info_btn_row, textvariable=self.info_status_var, foreground="#2e7d32").pack(side="left", padx=8)

        children_frame = ttk.LabelFrame(self, text="Add Children", padding=10)
        children_frame.pack(side="top", fill="both", expand=True, padx=10, pady=6)

        # Pin the action row (and its status label) to the bottom of this
        # frame BEFORE packing the scroll area, so it can never be pushed
        # out of view no matter how many rows are added.
        self.children_status_var = tk.StringVar()
        table_btn_row = ttk.Frame(children_frame)
        table_btn_row.pack(side="bottom", fill="x", pady=(6, 0))
        ttk.Button(table_btn_row, text="+ Add Row", command=self._add_row).pack(side="left")
        ttk.Button(table_btn_row, text="Import from CSV...", command=self._import_csv).pack(side="left", padx=6)
        ttk.Button(table_btn_row, text="Save Children", command=self._save_children).pack(side="left")
        ttk.Label(table_btn_row, textvariable=self.children_status_var, foreground="#2e7d32").pack(side="left", padx=8)

        header = ttk.Frame(children_frame)
        header.pack(side="top", fill="x")
        ttk.Label(header, text="Name", width=20).pack(side="left")
        ttk.Label(header, text="Relationship", width=20).pack(side="left")
        ttk.Label(header, text="Extra (key: value; key2: value2)").pack(side="left", fill="x", expand=True)

        self.rows_container = VerticalScrolledFrame(children_frame, height=220)
        self.rows_container.pack(side="top", fill="both", expand=True, pady=(2, 6))

        for _ in range(3):
            self._add_row()

    def _add_row(self):
        row_frame = ttk.Frame(self.rows_container.interior)
        row_frame.pack(fill="x", pady=1)

        name_var = tk.StringVar()
        ttk.Entry(row_frame, textvariable=name_var, width=20).pack(side="left")

        rel_var = tk.StringVar(value=RELATIONSHIP_OPTIONS[0])
        rel_combo = ttk.Combobox(row_frame, textvariable=rel_var, state="readonly", values=RELATIONSHIP_OPTIONS, width=18)
        rel_combo.pack(side="left")
        bind_relationship_digit_keys(rel_combo, rel_var)

        extra_var = tk.StringVar()
        ttk.Entry(row_frame, textvariable=extra_var).pack(side="left", fill="x", expand=True)

        row = {"frame": row_frame, "name": name_var, "relationship": rel_var, "extra": extra_var}

        def remove_row():
            row_frame.destroy()
            self.rows.remove(row)

        ttk.Button(row_frame, text="x", width=2, command=remove_row).pack(side="left", padx=(4, 0))
        self.rows.append(row)
        return row

    def _import_csv(self):
        path = filedialog.askopenfilename(
            title="Import Children from CSV",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
            parent=self,
        )
        if not path:
            return

        try:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                if not reader.fieldnames:
                    raise ValueError("CSV file is empty.")
                field_lookup = {name.strip().lower(): name for name in reader.fieldnames}
                if "name" not in field_lookup:
                    raise ValueError('CSV must have a "Name" column.')
                raw_rows = list(reader)
        except (OSError, csv.Error, ValueError) as e:
            messagebox.showerror("Import failed", str(e), parent=self)
            return

        parsed = []
        errors = []
        for i, raw_row in enumerate(raw_rows, start=2):  # row 1 is the header
            name = (raw_row.get(field_lookup["name"]) or "").strip()
            if not name:
                continue
            rel_cell = (raw_row.get(field_lookup.get("relationship", "")) or "").strip()
            extra_cell = (raw_row.get(field_lookup.get("extra", "")) or "").strip()
            try:
                relationship = parse_relationship_cell(rel_cell)
                parse_extra_inline(extra_cell)
            except ValueError as e:
                errors.append(f"Row {i}: {e}")
                continue
            parsed.append((name, relationship, extra_cell))

        if errors:
            messagebox.showerror("Import failed", "Fix these rows and re-import:\n\n" + "\n".join(errors), parent=self)
            return
        if not parsed:
            messagebox.showinfo("Import CSV", "No rows with a Name were found in that file.", parent=self)
            return

        for name, relationship, extra_cell in parsed:
            row = self._add_row()
            row["name"].set(name)
            row["relationship"].set(f"{relationship} - {RELATIONSHIP_LABELS[relationship]}")
            row["extra"].set(extra_cell)

        self.children_status_var.set(f"Imported {len(parsed)} row(s) - review, then click Save Children.")
        self.after(4000, lambda: self.children_status_var.set(""))

    def _save_info(self):
        name = self.name_var.get().strip()
        if not name:
            messagebox.showerror("Invalid input", "Name is required.", parent=self)
            return
        try:
            extra = parse_extra_text(self.extra_text.get("1.0", "end"))
        except ValueError as e:
            messagebox.showerror("Invalid extra field", str(e), parent=self)
            return
        relationship = relationship_value(self.relationship_var.get())
        self.app.update_person_info(self.person_id, name, relationship, extra)
        self.title(f"Details - {name}")
        self.info_status_var.set("Saved.")
        self.after(2000, lambda: self.info_status_var.set(""))

    def _save_children(self):
        existing_ids = {p["id"] for p in self.app.people}
        new_people = []
        for row in self.rows:
            name = row["name"].get().strip()
            if not name:
                continue
            try:
                extra = parse_extra_inline(row["extra"].get())
            except ValueError as e:
                messagebox.showerror("Invalid extra field", str(e), parent=self)
                return
            relationship = relationship_value(row["relationship"].get())
            new_id = suggest_new_id(existing_ids)
            existing_ids.add(new_id)
            new_people.append({
                "id": new_id,
                "name": name,
                "parent": self.person_id,
                "relationship": relationship,
                "extra": extra,
            })

        if not new_people:
            messagebox.showinfo("Add Children", "Enter at least one name.", parent=self)
            return

        self.app.add_children_bulk(new_people)
        for row in self.rows:
            row["frame"].destroy()
        self.rows = []
        for _ in range(3):
            self._add_row()
        self.children_status_var.set(f"Added {len(new_people)} child(ren).")
        self.after(2500, lambda: self.children_status_var.set(""))


class FamilyTreeApp:
    def __init__(self, root, data_path):
        self.root = root
        self.data_path = data_path
        self.people = []
        self.collapsed = set()
        self.selected_node_positions = {}
        self.node_boxes = {}
        self._pan_start = None

        root.title("Jewett Lab Family Tree Maker")
        root.geometry("1300x800")

        self._build_menu()

        main = ttk.Frame(root)
        main.pack(fill="both", expand=True)

        left = ttk.Frame(main, padding=8)
        left.pack(side="left", fill="y")

        self.tree_view = ttk.Treeview(
            left, columns=("name", "parent", "relationship"), show="headings", height=18
        )
        self.tree_view.heading("name", text="Name")
        self.tree_view.heading("parent", text="Parent")
        self.tree_view.heading("relationship", text="Relationship")
        self.tree_view.column("name", width=150)
        self.tree_view.column("parent", width=110)
        self.tree_view.column("relationship", width=140)
        self.tree_view.pack(fill="x")
        self.tree_view.bind("<<TreeviewSelect>>", self._on_row_selected)

        self.form = PersonForm(
            left, on_save=self._save_person, on_delete=self._delete_person,
            on_clear=lambda: None, get_people=lambda: self.people,
        )
        self.form.pack(fill="x", pady=(10, 0))
        self.form._clear()

        right = ttk.Frame(main, padding=8)
        right.pack(side="left", fill="both", expand=True)

        self.figure = plt.Figure(figsize=(8, 7))
        self.ax = self.figure.add_subplot(111)
        self.canvas = FigureCanvasTkAgg(self.figure, master=right)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self.canvas.mpl_connect("button_press_event", self._on_canvas_button_press)
        self.canvas.mpl_connect("motion_notify_event", self._on_canvas_motion)
        self.canvas.mpl_connect("button_release_event", self._on_canvas_button_release)
        self.canvas.mpl_connect("scroll_event", self._on_canvas_scroll)

        toolbar = NavigationToolbar2Tk(self.canvas, right)
        toolbar.update()

        hint_row = ttk.Frame(right)
        hint_row.pack(fill="x", pady=(4, 0))
        ttk.Button(hint_row, text="Expand All", command=self._expand_all).pack(side="left")
        hint = ("Right-click a node to add a child, edit, expand/collapse, or delete. "
                "Branches whose children have no children of their own start collapsed - "
                "expand them here or via right-click. Middle-click drag = pan, scroll = zoom.")
        ttk.Label(hint_row, text=hint, foreground="#555555").pack(side="left", padx=8)

        self.status_var = tk.StringVar()
        ttk.Label(root, textvariable=self.status_var, anchor="w", padding=4).pack(fill="x", side="bottom")

        self._load_from_disk(self.data_path, notify=False)

    def _build_menu(self):
        menubar = tk.Menu(self.root)
        file_menu = tk.Menu(menubar, tearoff=False)
        file_menu.add_command(label="New", command=self._new_file)
        file_menu.add_command(label="Open...", command=self._open_file)
        file_menu.add_command(label="Save", command=self._save_file)
        file_menu.add_command(label="Save As...", command=self._save_file_as)
        file_menu.add_separator()
        file_menu.add_command(label="Load Example Data", command=self._load_example)
        file_menu.add_command(label="Export Tree as PNG...", command=self._export_png)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.root.quit)
        menubar.add_cascade(label="File", menu=file_menu)
        self.root.config(menu=menubar)

    def _set_status(self, message):
        self.status_var.set(message)

    def get_person(self, person_id):
        return next((p for p in self.people if p["id"] == person_id), None)

    def _load_from_disk(self, path, notify=True):
        try:
            self.people = load_data(path)
        except (ValueError, json.JSONDecodeError) as e:
            messagebox.showerror("Load failed", str(e))
            return
        self.data_path = path
        self.collapsed = compute_default_collapsed(self.people)
        self.root.title(f"Jewett Lab Family Tree Maker - {path}")
        self._refresh_all()
        if notify:
            self._set_status(f"Loaded {len(self.people)} individuals from {path}")

    def _new_file(self):
        if self.people and not messagebox.askyesno(
            "New file", "Discard current data and start a new tree?"
        ):
            return
        self.people = []
        self.collapsed = set()
        self.data_path = DEFAULT_DATA_PATH
        self.root.title(f"Jewett Lab Family Tree Maker - {self.data_path}")
        self._refresh_all()
        self._set_status("Started a new, empty tree.")

    def _open_file(self):
        path = filedialog.askopenfilename(filetypes=[("JSON files", "*.json"), ("All files", "*.*")])
        if path:
            self._load_from_disk(path)

    def _save_file(self):
        try:
            save_data(self.data_path, self.people)
            self._set_status(f"Saved {len(self.people)} individuals to {self.data_path}")
        except OSError as e:
            messagebox.showerror("Save failed", str(e))

    def _save_file_as(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".json", filetypes=[("JSON files", "*.json")]
        )
        if path:
            self.data_path = path
            self._save_file()
            self.root.title(f"Jewett Lab Family Tree Maker - {self.data_path}")

    def _load_example(self):
        if not os.path.exists(EXAMPLE_DATA_PATH):
            messagebox.showerror("Not found", f"{EXAMPLE_DATA_PATH} was not found.")
            return
        if self.people and not messagebox.askyesno(
            "Load example", "This replaces your current data. Continue?"
        ):
            return
        self.people = load_data(EXAMPLE_DATA_PATH)
        self.collapsed = compute_default_collapsed(self.people)
        self._refresh_all()
        self._set_status(f"Loaded example data ({len(self.people)} individuals).")

    def _export_png(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".png", filetypes=[("PNG image", "*.png")]
        )
        if path:
            self.figure.savefig(path, dpi=200, bbox_inches="tight")
            self._set_status(f"Exported tree image to {path}")

    def _save_person(self, person, is_new):
        if is_new:
            self.people.append(person)
        else:
            for i, p in enumerate(self.people):
                if p["id"] == person["id"]:
                    self.people[i] = person
                    break
        self._refresh_all()
        self.form._clear()
        self._set_status(f'Saved "{person["name"]}".')

    def update_person_info(self, person_id, name, relationship, extra):
        person = self.get_person(person_id)
        if person is None:
            return
        person["name"] = name
        person["relationship"] = relationship
        person["extra"] = extra
        self._refresh_all()
        self._set_status(f'Updated "{name}".')

    def add_children_bulk(self, new_people):
        self.people.extend(new_people)
        self._refresh_all()
        self._set_status(f"Added {len(new_people)} new individual(s).")

    def _delete_person(self, person_id):
        person = self.get_person(person_id)
        if person is None:
            return
        descendants = find_descendants({p["id"]: p for p in self.people}, person_id)
        cascade = False
        if descendants:
            answer = messagebox.askyesnocancel(
                "Delete individual",
                f'"{person["name"]}" has {len(descendants)} descendant(s) in the tree.\n\n'
                'Yes = delete this person AND all descendants.\n'
                "No = delete only this person and reattach their children to their parent.\n"
                "Cancel = abort.",
            )
            if answer is None:
                return
            cascade = answer

        ids_to_remove = {person_id}
        if cascade:
            ids_to_remove.update(descendants)
        else:
            for p in self.people:
                if p.get("parent") == person_id:
                    p["parent"] = person.get("parent")

        self.people = [p for p in self.people if p["id"] not in ids_to_remove]
        self.collapsed -= ids_to_remove
        self._refresh_all()
        self.form._clear()
        self._set_status(f'Deleted "{person["name"]}"' + (f" and {len(descendants)} descendant(s)." if cascade else "."))

    def _has_children(self, person_id):
        return any(p.get("parent") == person_id for p in self.people)

    def _toggle_collapse(self, person_id):
        person = self.get_person(person_id)
        if person is None:
            return
        if person_id in self.collapsed:
            self.collapsed.discard(person_id)
            self._set_status(f'Expanded "{person["name"]}".')
        else:
            self.collapsed.add(person_id)
            self._set_status(f'Collapsed "{person["name"]}".')
        self._redraw_tree()

    def _expand_all(self):
        self.collapsed.clear()
        self._redraw_tree()
        self._set_status("Expanded all nodes.")

    def _select_and_load(self, person_id):
        self.tree_view.selection_set(person_id)
        self.tree_view.see(person_id)

    def _quick_add_child(self, parent_id):
        parent_person = self.get_person(parent_id)
        if parent_person is None:
            return

        def on_add(name, relationship, extra):
            new_id = suggest_new_id({p["id"] for p in self.people})
            self._save_person(
                {"id": new_id, "name": name, "parent": parent_id, "relationship": relationship, "extra": extra},
                is_new=True,
            )
            self._select_and_load(new_id)

        QuickAddChildDialog(self.root, parent_person, on_add)

    def _open_node_details(self, person_id):
        if self.get_person(person_id) is None:
            return
        NodeDetailsWindow(self.root, self, person_id)

    def _on_row_selected(self, _event):
        selection = self.tree_view.selection()
        if not selection:
            return
        person = self.get_person(selection[0])
        if person:
            self.form.load_person(person)

    def _refresh_all(self):
        self._refresh_table()
        self.form.refresh_parent_options(exclude_id=self.form.editing_id)
        self._redraw_tree()

    def _refresh_table(self):
        self.tree_view.delete(*self.tree_view.get_children())
        people_by_id = {p["id"]: p for p in self.people}
        for p in sorted(self.people, key=lambda x: x.get("name", "")):
            parent = p.get("parent")
            parent_label = people_by_id[parent]["name"] if parent in people_by_id else "-"
            rel_label = RELATIONSHIP_LABELS.get(p.get("relationship", 0), "Unknown")
            self.tree_view.insert("", "end", iid=p["id"], values=(p.get("name", ""), parent_label, rel_label))

    def _redraw_tree(self):
        self.ax.clear()
        self.selected_node_positions = {}
        self.node_boxes = {}

        if not self.people:
            self.ax.text(0.5, 0.5, "No individuals yet.\nUse the form on the left to add one.",
                         ha="center", va="center", fontsize=12)
            self.ax.axis("off")
            self.canvas.draw()
            return

        layout = TreeLayout(self.people, self.collapsed)
        coords, edges, badges, compact_ids, column_labels = layout.compute()

        for parent_id, child_id in edges:
            px, py = coords[parent_id]
            cx, cy = coords[child_id]
            parent_h = LEAF_NODE_HEIGHT if parent_id in compact_ids else NODE_HEIGHT
            child_h = LEAF_NODE_HEIGHT if child_id in compact_ids else NODE_HEIGHT
            self.ax.plot([px, cx], [py - parent_h / 2, cy + child_h / 2],
                         color="#888888", linewidth=1.2, zorder=1)

        for col_x, col_y, label in column_labels:
            self.ax.text(col_x, col_y, label, ha="center", va="bottom", fontsize=7,
                         color="#555555", style="italic", zorder=2)

        for person in self.people:
            pid = person["id"]
            if pid not in coords:
                continue
            x, y = coords[pid]
            is_compact = pid in compact_ids
            is_collapsed = pid in badges
            width = LEAF_NODE_WIDTH if is_compact else NODE_WIDTH
            height = LEAF_NODE_HEIGHT if is_compact else NODE_HEIGHT
            color = RELATIONSHIP_COLORS.get(person.get("relationship", 0), "#9e9e9e")
            box = plt.Rectangle(
                (x - width / 2, y - height / 2), width, height,
                facecolor=color, edgecolor="black", linewidth=1.0,
                linestyle="dashed" if is_collapsed else "solid", zorder=2,
            )
            self.ax.add_patch(box)
            label = person.get("name", pid)
            if is_collapsed:
                label += f"\n▸ {badges[pid]} hidden"
            self.ax.text(x, y, label, ha="center", va="center",
                         fontsize=7.5 if is_compact else 8.5,
                         color="white", zorder=3, wrap=True)
            self.selected_node_positions[pid] = (x, y)
            self.node_boxes[pid] = (width, height)

        handles = [
            plt.Rectangle((0, 0), 1, 1, facecolor=color)
            for color in RELATIONSHIP_COLORS.values()
        ]
        self.ax.legend(handles, list(RELATIONSHIP_LABELS.values()), loc="upper left",
                       fontsize=7, framealpha=0.9)

        xs = [c[0] for c in coords.values()]
        ys = [c[1] for c in coords.values()]
        self.ax.set_xlim(min(xs) - NODE_WIDTH, max(xs) + NODE_WIDTH)
        self.ax.set_ylim(min(ys) - NODE_HEIGHT * 2, max(ys) + NODE_HEIGHT * 2)

        self.ax.set_aspect("auto")
        self.ax.axis("off")
        self.ax.set_title("Academic Family Tree (right-click a node for options)")
        self.figure.tight_layout()
        self.canvas.draw()

    def _find_node_at(self, event):
        if event.xdata is None or event.ydata is None or not self.selected_node_positions:
            return None
        best_id, best_dist = None, None
        for pid, (x, y) in self.selected_node_positions.items():
            dist = (x - event.xdata) ** 2 + (y - event.ydata) ** 2
            if best_dist is None or dist < best_dist:
                best_id, best_dist = pid, dist
        if best_id is None:
            return None
        width, height = self.node_boxes.get(best_id, (NODE_WIDTH, NODE_HEIGHT))
        if best_dist <= (width / 2) ** 2 + (height / 2) ** 2:
            return best_id
        return None

    def _on_canvas_button_press(self, event):
        if event.button == 2:
            self._pan_start = (event.x, event.y, self.ax.get_xlim(), self.ax.get_ylim())
            return
        if event.button == 3:
            pid = self._find_node_at(event)
            if pid is not None:
                self._show_node_context_menu(event, pid)
            return
        if event.button == 1:
            pid = self._find_node_at(event)
            if pid is not None:
                self._select_and_load(pid)

    def _on_canvas_motion(self, event):
        if self._pan_start is None or event.x is None or event.y is None:
            return
        x0, y0, xlim0, ylim0 = self._pan_start
        inv = self.ax.transData.inverted()
        x0d, y0d = inv.transform((x0, y0))
        x1d, y1d = inv.transform((event.x, event.y))
        dx, dy = x0d - x1d, y0d - y1d
        self.ax.set_xlim(xlim0[0] + dx, xlim0[1] + dx)
        self.ax.set_ylim(ylim0[0] + dy, ylim0[1] + dy)
        self.canvas.draw_idle()

    def _on_canvas_button_release(self, event):
        if event.button == 2:
            self._pan_start = None

    def _on_canvas_scroll(self, event):
        if event.button == "up":
            scale = 1 / ZOOM_SCALE
        elif event.button == "down":
            scale = ZOOM_SCALE
        else:
            return

        xlim = self.ax.get_xlim()
        ylim = self.ax.get_ylim()
        x = event.xdata if event.xdata is not None else (xlim[0] + xlim[1]) / 2
        y = event.ydata if event.ydata is not None else (ylim[0] + ylim[1]) / 2

        new_xlim = [x - (x - xlim[0]) * scale, x + (xlim[1] - x) * scale]
        new_ylim = [y - (y - ylim[0]) * scale, y + (ylim[1] - y) * scale]
        self.ax.set_xlim(new_xlim)
        self.ax.set_ylim(new_ylim)
        self.canvas.draw_idle()

    def _show_node_context_menu(self, event, person_id):
        person = self.get_person(person_id)
        if person is None:
            return
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label=f'Edit "{person["name"]}"', command=lambda: self._select_and_load(person_id))
        menu.add_command(label="Add Child...", command=lambda: self._quick_add_child(person_id))
        menu.add_command(label="Open Details...", command=lambda: self._open_node_details(person_id))
        if self._has_children(person_id):
            toggle_label = "Expand Descendants" if person_id in self.collapsed else "Collapse Descendants"
            menu.add_command(label=toggle_label, command=lambda: self._toggle_collapse(person_id))
        menu.add_separator()
        menu.add_command(label="Delete", command=lambda: self._delete_person(person_id))

        gui_event = event.guiEvent
        x_root = getattr(gui_event, "x_root", self.canvas.get_tk_widget().winfo_pointerx())
        y_root = getattr(gui_event, "y_root", self.canvas.get_tk_widget().winfo_pointery())
        try:
            menu.tk_popup(x_root, y_root)
        finally:
            menu.grab_release()


def main():
    data_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DATA_PATH
    root = tk.Tk()
    FamilyTreeApp(root, data_path)
    root.mainloop()


if __name__ == "__main__":
    main()

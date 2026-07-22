# Jewett Lab Family Tree Maker

## GUI Application

`family_tree_app.py` is a Tkinter desktop app for building and visualizing an
academic family tree that matches the schema below.

### Setup

```bash
pip install -r requirements.txt
```

### Run

```bash
python family_tree_app.py [path/to/data.json]
```

If no path is given, it defaults to `family_tree_data.json` in the current
directory (created on first save). Use **File > Load Example Data** to try it
out with `database_example.json`.

### Features

- Add, edit, and delete individuals from the form on the left; the table
  above it lists everyone currently in the tree.
- `extra` fields are entered as one `key: value` line each; numeric values
  are stored as numbers automatically.
- The tree on the right redraws automatically, colored by relationship type,
  and stretches to fill the available space rather than staying locked to a
  fixed aspect ratio.
  - **Left-click** a node to select/edit it in the left-hand form.
  - **Right-click** a node for a context menu: Edit, Add Child..., Open
    Details..., Expand/Collapse Descendants (if it has children), Delete.
  - **Middle-click and drag** to pan around the tree (no toolbar mode needed).
  - **Scroll** to zoom in/out, centered on the cursor.
  - The toolbar below the tree still offers zoom, rectangle-zoom, and
    save-image.
- To keep large trees readable, a person whose children have no children of
  their own (a "leaf cluster" - e.g. a cohort of students with no students of
  their own) starts **collapsed** into a dashed badge showing how many are
  hidden. This gives branches that keep growing more room and visual
  priority. Expand one via its right-click menu, or click "Expand All" above
  the tree to reveal everything.
  - When a leaf cluster is expanded, its children are grouped into columns
    by relationship (all undergrads in one column, all postdocs in another,
    etc.) and stacked vertically, instead of spreading each one across the
    width of the tree.
- "Add Child..." from the right-click menu opens a small dialog to add one
  child directly, without using the left-hand form.
- "Open Details..." opens a window for that person with their info (editable)
  and a table for bulk-adding several children at once (name, relationship,
  and extra per row).
  - Use "+ Add Row" to add more rows, or the "x" button on a row to remove it.
  - In the Relationship column, type a digit 0-4 to jump straight to that
    relationship instead of opening the dropdown.
  - "Import from CSV..." loads rows into the table from a CSV file with
    `Name`, `Relationship`, and `Extra` columns (relationship can be a code
    like `3`, a label like `PhD student`, or `3 - PhD student`; extra uses
    the same `key: value; key2: value2` format as the table). Imported rows
    land in the table for review — nothing is added until you click
    "Save Children".
  - Rows with a blank name are ignored on save, so leftover empty rows never
    create blank individuals.
- Deleting someone with descendants lets you choose whether to delete the
  whole subtree or reattach their children to their parent.
- **File** menu: New, Open, Save, Save As, Load Example Data, Export Tree as
  PNG.

## Web Viewer (GitHub Pages)

`docs/` contains a static, read-only web version of the tree for sharing
publicly — no editing, just browsing. It's built with plain HTML/CSS/JS plus
[D3.js](https://d3js.org/) (loaded from a CDN), so it needs no build step and
runs entirely in the browser.

### Preview locally

Browsers block `fetch()` of local files opened directly (`file://`), so serve
the folder over HTTP instead:

```bash
python -m http.server 8000 --directory docs
```

Then open `http://localhost:8000/`.

### Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In **Settings > Pages**, set **Source** to "Deploy from a branch", branch
   `main`, folder `/docs`.
3. GitHub will publish the site at `https://<username>.github.io/<repo>/`.

`docs/data.json` currently ships as a copy of `DIC_Wang_Family_Tree_with_coadvisement.json`.
To use a different tree, replace it (same schema as below) — for example:
```bash
cp Jim_Swartz_Subtree.json docs/data.json
```
Or point the viewer at any JSON file without renaming anything, e.g.
`index.html?data=my_other_tree.json`. You can also load a file straight from
your computer with the **Upload JSON...** button in the toolbar — nothing
gets uploaded anywhere, it's read entirely in your browser.

### Features

- Styled after [FamilySearch](https://www.familysearch.org/)'s tree view:
  rounded person cards with colored avatar initials, connected by soft
  curved lines.
- **Landscape / Portrait / Fan** orientation toggle (top toolbar) — switch
  between generations flowing left-to-right, top-to-bottom, or radiating
  outward from a center point. All three share the same layout engine, so
  nothing overlaps in any of them, however deeply a cluster is nested. Fan
  mode looks best once you've narrowed the view down to a subtree (see
  below) rather than the entire tree at once.
- **Filters** panel (top right) lets you show/hide individuals by
  relationship type (undergrad, master's, PhD, postdoc, unknown), with a live
  count of how many of each are in the tree. Hiding a type reconnects that
  person's visible descendants to their nearest visible ancestor, so the tree
  never breaks apart.
- **Expand/collapse in both directions** to isolate any part of the tree:
  - Click the **›** button on a card to expand/collapse that person's
    descendants.
  - Click the **‹** button to isolate everything from that person down,
    hiding their ancestors. A breadcrumb trail appears so you can jump back
    to any ancestor, or all the way to "Full Tree".
  - Every childless child of a person is automatically grouped into its own
    "N students, no further descendants" cluster card, collapsed by
    default — separate from any siblings who *do* have descendants (those
    stay as ordinary individual cards, expanded by default). This applies
    even when a person has a mix of both, so one prolific advisor with a
    few well-established academic children and dozens of one-off students
    doesn't force everyone into a single giant list. Click a cluster card
    to expand it into a compact grid grouped by relationship type; a small
    **−** button floats above it to collapse it back. The layout
    automatically reserves however much extra room an expanded cluster
    needs so it can never overlap a neighboring branch, however deeply
    nested.
- **Search** by name; results jump to and highlight that person, expanding
  any collapsed ancestors (and their own cluster, if they're in one) along
  the way so they're actually visible.
- Click any card to open a detail panel with their advisor(s), direct/total
  descendant counts, and any `extra` fields.
- Scroll to zoom, drag to pan, or use the on-screen zoom controls.
- **Co-advisement**: a secondary advisor is drawn as a dashed gold arc to
  that person, deliberately bowed out so it still reads clearly even when
  both people are in the same generation (where a straight line would be
  easy to miss). A co-advised person is never folded into a cluster - even
  if they'd otherwise have no children of their own - so the link always
  has a real standalone card to point at, rather than disappearing when a
  cluster collapses or getting lost weaving through one when it's expanded.
  If you isolate on one of their advisors (the **‹** button) and their
  *other* advisor falls outside that view, they still show up as a small
  dashed card floated next to whichever advisor is visible, so the
  relationship stays visible no matter which side you're looking from. See
  the schema note below.

## Database Schema

Each individual in the family tree is represented as a JSON object with the following fields:

| Field          | Type           | Description                                                                 |
|----------------|----------------|-------------------------------------------------------------------------------|
| `id`           | string         | Unique identifier for the individual.                                        |
| `name`         | string         | Full name of the individual.                                                 |
| `parent`       | string \| string[] \| null | `id` of this person's advisor/mentor node. `null` if there is no parent (e.g. root of the tree, or relationship unknown). May also be a **list of ids** for a co-advised person - see note below. |
| `relationship` | integer        | Relationship to the parent node. See enum below.                             |
| `extra`        | object         | Free-form key/value object for any additional information. Not validated against a fixed schema, so contributors can add new fields (e.g. `institution`, `start_year`, `field`) without needing to update the data model. |

**`relationship` enum:**

| Value | Meaning                |
|-------|-------------------------|
| 0     | Unknown                 |
| 1     | Undergraduate student   |
| 2     | Master's student        |
| 3     | PhD student             |
| 4     | Postdoctoral scholar    |

### Example

```json
[
  {
    "id": "p001",
    "name": "Mike Jewett",
    "parent": null,
    "relationship": 0,
    "extra": {}
  },
  {
    "id": "p002",
    "name": "Chad Hyer",
    "parent": "p001",
    "relationship": 3,
    "extra": {
      "institution": "Stanford University",
      "start_year": 2025,
      "field": "Synthetic Biology"
    }
  },
  {
    "id": "p003",
    "name": "Jane Smith",
    "parent": "p001",
    "relationship": 4,
    "extra": {
      "start_year": 2022,
      "end_year": 2024
    }
  }
]
```

### Notes

- The desktop app (`family_tree_app.py`) only reads/writes a single `parent`
  id — co-advised individuals need one advisor designated as the primary
  parent there. The **web viewer** additionally understands `parent` as a
  list of ids: the first is treated as the primary advisor for the tree's
  structure, and any others are drawn as a dashed "co-advised by" line. For
  example, `"parent": ["p163", "p579"]` means primarily advised by `p163`,
  co-advised by `p579`. See `DIC_Wang_Family_Tree_with_coadvisement.json`
  for a real example (Meagan Olsen, co-advised by Michael Jewett and Ashty
  Karim).
- The `extra` field is intentionally unstructured — treat it as a place for contributors to record whatever context is useful (thesis title, lab URL, funding source, etc.) without requiring changes to the core schema.
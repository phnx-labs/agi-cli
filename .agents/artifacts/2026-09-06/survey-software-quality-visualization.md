# Visualizing Software Quality, Health, Architecture, Duplication, and Structure

A design-exploration survey of 40 years of software visualization, plus how practitioners actually judge a codebase, plus what an AI coding agent needs that a human does not.

This is a source-grounded catalog, not a mood board. Every named concept below is something a person has shipped, papered, or used in anger. Years and tools are attached so a later prototype can steal the right ancestor instead of reinventing a known failure.

---

## 0. How this field actually organizes itself

Diehl's textbook (*Software Visualization*, Springer 2007) splits the field into **structure** (static), **behaviour** (dynamic/runtime), and **evolution** (history). That split is still the right first cut. Everything else — metrics dashboards, clone maps, knowledge maps, Copilot heatmaps — is a *question asked of one of those three data sources*.

Card, Mackinlay, and Shneiderman's visual-information-seeking mantra (1999) is the second cut, and it is load-bearing:

> Overview first, zoom and filter, then details-on-demand.

Almost every failed software visualization violates this. A 3D city flythrough has no overview. A 40-metric SonarQube homepage has no filter that maps to a decision. A force-directed import graph of 8,000 files has no zoom that preserves meaning.

A third cut, from Munzner (*Visualization Analysis and Design*, 2014) and from the DSM literature, is **what the visual encoding is for**:

| Encoding family | Scales to | Answers | Dies when |
|---|---|---|---|
| Space-filling hierarchy (treemap, sunburst, icicle, Voronoi) | 10⁴–10⁶ leaves | Where is the mass? | Relationships, not containment, are the question |
| Pixel / line map (SeeSoft) | 10⁴–10⁵ lines | Where is the property spatially? | You need topology, not locality |
| Node-link graph | ~10² nodes readable | Who talks to whom, locally | Degree > ~8, N > ~200 ("hairball") |
| Adjacency matrix / DSM | 10²–10³ elements | Cycles, layers, clusters | Labels don't fit, or the order is wrong |
| Scatter / small multiples | 10²–10⁴ points | Outliers vs. a model | Axes aren't a real model |
| Temporal animation (Gource, code_swarm) | years of commits | Narrative of growth | You need a decision, not a story |
| Dual comparison (two trees, two matrices, two SeeSofts) | pairwise | What changed / what matches | N-way comparison |

The rest of this document uses those three cuts.

---

## 1. Taxonomy of visualization GENRES

Six genres. Each genre is a *question class*, not a chart type. A treemap can serve structure, risk, or evolution depending on what you map to area and color. Do not pick a chart and then hunt for a metric; pick the question, then pick the encoding.

### G1. Structure — "What is the shape of this system?"

Containment (packages, modules, files), declared dependencies, layering, cycles, public vs. internal. Ancestors: UML class diagrams (Booch/Rumbaugh/Jacobson, 1990s), Graphviz/dot (Gansner et al., AT&T, 1988–1993), Structure101 Levelized Structure Maps, Lattix/NDepend DSMs, madge, dependency-cruiser.

Human judgment this genre serves: god modules, fan-in/fan-out, API surface sprawl, dead types, layering violations.

### G2. Similarity — "What is the same, twice?"

Clone classes, near-duplicates, forked implementations, copy-paste families, isomorphic ASTs. Ancestors: Baker Dup (1992/1995), Duploc scatterplots (Rieger/Ducasse 1998), CCFinder + Gemini (Kamiya et al. 2002), NiCad (Roy/Cordy 2008), Deckard (Jiang et al. ICSE 2007), PMD CPD, jscpd, copydetect.

Human judgment this genre serves: duplication that is *maintenance-coupled* (a bug-fix must land N times) vs. coincidental similarity.

### G3. Usage — "What actually runs / is actually referenced?"

Call graphs, type-usage matrices, coverage vs. execution frequency, SCIP/LSIF reference graphs, flame graphs, dead-code reachability. Ancestors: Understand (SciTools) butterfly/call graphs, gprof call graphs, Gregg flame graphs (2011), rust-analyzer/tsserver as graph sources, Sourcegraph SCIP (2022).

Human judgment this genre serves: dead types, fan-in that is real vs. declared, test coverage that is theatrical, "this API looks public but has one caller."

### G4. Evolution — "How did we get here, and where is the motion?"

Churn, co-change, complexity trends, authorship, Gource trees, evolution matrices, GitHub contribution graphs. Ancestors: SeeSoft age coloring (Eick 1992), Lanza Evolution Matrix (IWPSE 2001), code_swarm (Ogawa/Ma 2008/2009), Gource (Caudwell 2009/2010), Tornhill hotspots (2015).

Human judgment this genre serves: churn × complexity hotspots, "this file is done vs. this file is a construction site," knowledge concentration.

### G5. Risk — "Where will the next expensive mistake land?"

Hotspots, bus factor, defect-prone modules, instability/abstractness outliers, security variant graphs (CodeQL). Ancestors: Nagappan/Ball relative code churn (ICSE 2005/2006), Tornhill *Your Code as a Crime Scene* (2015) and CodeScene, Martin main sequence (1994), Avelino truck factor (ICPC 2016).

Human judgment this genre serves: where to refactor, where not to, who can merge this, what an agent should not touch unsupervised.

### G6. Contracts — "What is the promised surface, and is it being honored?"

Public API census, allowed vs. actual dependencies (Structure101 overlays, dependency-cruiser rules, Lattix DSM rules), semantic versioning / export maps, architectural fitness functions. This is the genre most tools skip and the one architects actually enforce.

Human judgment this genre serves: API surface sprawl, layering, "can I delete this?", "did the agent just import infra from UI?"

**Orthogonal overlays** (not genres, but encodings you drop onto any genre): ownership color, recency, complexity, coverage, Copilot/agent-edit traffic, issue density.

---

## 2. How humans actually judge codebase health

Practitioners do not look at a "health score." They pattern-match a small set of *scenes*. Any visualization that cannot make these scenes pop in under five seconds will not get used twice.

### 2.1 God modules / Blob classes

The file or class that is both huge and heavily depended-on. Lanza/Ducasse polymetric "System Complexity" view (TSE 2003): node width = number of attributes, height = number of methods, color = LOC. The god class is the tall, wide, dark rectangle. CodeCity maps the same two metrics to building base and height, which is why cities *do* find god classes even when the rest of the metaphor fails. NDepend's "types to refactor" queries are the same scene in a table.

A human uses this to decide: "I will not add a 15th method here; I will extract." An agent should use this as a *write-fence*: do not enlarge a god module without an extraction plan.

### 2.2 Cycles

Import/package cycles, especially ones that punch through a declared layer. Visible as a filled triangle above the diagonal in a partitioned DSM (Steward 1981; Eppinger/Browning *DSM Methods and Applications*, MIT Press 2012; Lattix; NDepend). Visible as a red strongly-connected-component in madge (`madge --circular`, nodes colored red) and as an orange highlight in dependency-cruiser's HTML wrap. Structure101 calls the same thing "tangled" and measures it as Excess Structural Complexity (XS).

A cycle that stays inside a package is often fine. A cycle between `cli/` and `packages/session-tracker` is an incident. Visualizations that cannot distinguish those two will cry wolf.

### 2.3 Duplication that is coupled, not coincidental

Type-1 (verbatim) and Type-2 (identifier-renamed) clones that cross module boundaries are the ones that hurt: a bug-fix must land N times, and it won't. CCFinder (Kamiya, Kusumoto, Inoue, TSE 2002) tokenizes and uses a suffix tree; Gemini/GemX scatterplots file×file so a clone family is a set of off-diagonal squares. NiCad (Roy & Cordy, 2008) pretty-prints then text-compares at function granularity — better at Type-3 (near-miss). Deckard (Jiang, Misherghi, Su, Glondu, ICSE 2007) vectors AST subtrees and clusters in Euclidean space — better at structural clones. PMD CPD (Karp–Rabin) and jscpd are the industrial CLI defaults. copydetect is the academic k-gram/winnowing cousin.

The scene a human wants: two file trees, a highlighted pair, a similarity %, and a one-click unified diff against a canonical occurrence. Scatterplots find the family; dual trees + diff decide the action.

### 2.4 Test coverage vs. test value

Line coverage is a terrible health metric used alone. 95% coverage of a generated serializer is noise; 40% coverage that misses the authn state machine is a page-out. SonarQube's coverage treemap (area = ncloc, color = coverage %) makes the first error — it celebrates covering the biggest files. The useful scene is **coverage × churn** or **coverage × cyclomatic of the changed region**: "the code we actually edit is untested." CodeScene-style hotspot overlays do this; raw JaCoCo/lcov badges do not.

### 2.5 API surface sprawl and dead types

`export *` barrels, public classes with one caller, types that rust-analyzer/`tsserver`/SCIP report as defined-but-unreferenced. Understand's "Called By" butterfly, Sourcegraph "Find references" aggregated to a histogram, and NDepend CQLinq (`from t in Types where t.NbTypesUsingMe == 0`) are the working tools. A usage matrix (types × types, cell = reference count) makes dead rows/columns visually empty — that emptiness is the insight.

### 2.6 Fan-in / fan-out, instability, abstractness, distance from main sequence

Martin, *OO Design Quality Metrics: An Analysis of Dependencies* (OOPSLA '94 workshop; later *Agile Software Development*, 2002):

- Ca = afferent coupling (who depends on me)
- Ce = efferent coupling (who I depend on)
- I = Ce / (Ca + Ce) — 0 stable, 1 unstable
- A = abstract types / all types
- Main sequence: A + I = 1
- Dn = |A + I − 1|
- Zone of Pain: I ≈ 0, A ≈ 0 (stable and concrete — `java.awt` in the original examples)
- Zone of Uselessness: I ≈ 1, A ≈ 1 (abstract and unused)

NDepend, JArchitect, JDepend, and a pile of later tools scatter A vs I with the diagonal drawn. The scene that matters is not the average Dn of the repo (a health-score sin) but **the two or three packages in the Zone of Pain that also have high Ca** — those are the ones whose concrete internals freeze the rest of the system.

### 2.7 Churn × complexity hotspots

Nagappan & Ball, "Use of Relative Code Churn Measures to Predict System Defect Density" (ICSE 2005) established that churn predicts defects better than size. Tornhill (*Your Code as a Crime Scene*, Pragmatic Bookshelf 2015; CodeScene thereafter) operationalized the scene: circle-packing / hierarchical treemap of the file tree, area ≈ LOC (complexity proxy), color ≈ commit frequency (or Code Health). The hotspot is the large, hot circle. Complexity *trends* (CodeScene fetches historic versions of a hotspot and plots indentation-as-complexity over time) distinguish "stable but historically busy" from "deteriorating now."

This is the single most used *actionable* visualization in industry that is not a dashboard of counts. It tells a tech lead where a refactor pays rent.

### 2.8 Bus factor / knowledge maps

Truck/Bus factor: minimum number of developers who, if hit by a bus, stall the project. Avelino et al., "A novel approach for estimating Truck Factors" (ICPC 2016): Degree of Authorship (Fritz et al. 2014) then greedy removal until >50% of files are orphaned. Ferreira et al. (ICPC 2017) compared three algorithms against a developer oracle; Avelino's won. CodeScene's knowledge map is a treemap colored by primary author / team, plus an off-boarding simulation. Git `blame` is the naive version and is wrong for files that were reformatted once by a bot.

The scene: a package that is one color (one person) *and* a hotspot *and* about to lose that person.

### 2.9 Change coupling (hidden architecture)

Files that co-change in the same commits but have no static import. This is the architecture the compiler cannot see: a protocol buffer and its hand-written mapper, a CSS file and a React component, a SQL migration and a DAO. CodeScene change-coupling view; also "logical coupling" in D'Ambros/Lanza work. A Sankey or a co-change matrix on top of the file tree is the right encoding. A static import graph will miss it entirely.

---

## 3. UI patterns that work (and the papers they come from)

These are the interaction patterns, independent of metaphor.

**Dual trees (left/right hierarchies with a similarity or diff encoding).** TreeJuxtaposer (Munzner et al., SIGGRAPH 2003) is the InfoVis canonical form: two trees, guaranteed visibility of marked nodes, accordion navigation. In code: clone tools that put file-tree A on the left, file-tree B on the right, edge or % on the pair, and a diff in the middle. Gemini (Ueda, Kamiya, Kusumoto, Inoue) already did scatterplot → source pair. Modern: Deslop cluster panel (canonical vs. occurrence in VS Code's native diff), CDDM studio, any "compare with canonical" clone UI. This is the correct UI for *similarity*, not a force graph of clone pairs.

**Adjacency matrix vs. node-link.** Ghoniem, Fekete, Castagliola (IEEE InfoVis 2004 / later TVCG): matrices beat node-link for large/dense graphs on most topology tasks; node-link wins only for small, sparse, path-following. For software this is why Lattix/NDepend DSM views survive at 500 types and Graphviz `fdp` of the same data does not. Rule: **node-link for an ego-network of one symbol (Understand butterfly); matrix for the system.**

**Small multiples.** Tufte's term; in software: Lanza Evolution Matrix (one cell per class×version, width/height encode metrics — "pulsating classes" jump out), SeeSoft with one column per file, CodeScene complexity-trend sparklines next to the hotspot table. Small multiples beat animation for comparison (Tversky, Morrison, Betrancourt, 2002: animation fails for analysis).

**Lens + overview, focus+context.** Furnas fisheye (CHI 1986); later Sarkar/Brown graphical fisheye; in IDEs, the minimap is a degenerate SeeSoft. The pattern that works for code is **overview (treemap/DSM/SeeSoft) + a lens that is the actual editor**, not a distorted projection. Semantic zoom (Perlin & Fox, Pad++, UIST 1993; later Google Maps) is the better sibling: zooming in *changes the representation* (package name → file name → function signature → source), rather than scaling the same glyphs until they are unreadable. CodeCity never got this right. Structure101's drill from LSM → class → method did.

**Matrix of type usage.** Rows = types, columns = types (or rows = files, columns = exported symbols). Cell = count of references, colored. Empty rows = dead. Dense columns = facades/god types. This is a DSM specialized to *use* rather than *depend*. NDepend does a version of this; it is underused.

**Sunburst of packages.** Stasko radial space-filling (2000); later D3 sunburst. Good for *containment browsing* ("where is the mass under `cli/src/lib`?"). Bad for dependencies (chords on a sunburst become Holten bundles, which is a different view). Icicle plots are the Cartesian form and label better (categories sit on a baseline). Prefer icicle when you need to read names; sunburst when you need a compact overview badge.

**Flame graphs for call frequency.** Gregg, 2011 (FlameGraph; CACM 2016 "The Flame Graph"). Width = sample count, y = stack depth, x is *alphabetical not time*. This is an icicle of a trie of stacks. It is the only call-graph visualization that routinely survives production. Do not put time on x unless you mean an icicle/timeline of a *single* trace (Jaeger, Chrome performance panel). Sampling flame graphs and tracing waterfalls answer different questions.

**Voronoi treemaps.** Balzer, Deussen, Lewerentz (SoftVis 2005): polygons instead of rectangles, better aspect ratios, clearer hierarchy boundaries. Nocaj & Brandes (CGF 2012) made them fast. Beautiful; expensive to compute; labels fight the irregular cells. Use when you are printing a poster of "where is the mass." Do not use as a daily tool unless layout is cached and stable across runs — jittering districts destroy the spatial memory that makes treemaps useful.

**3D cities.** Wettel & Lanza, CodeCity (VISSOFT 2007); controlled experiment vs. Excel (ICSE 2011) showed *task* gains for program comprehension on medium systems. CodeMetropolis (Balogh et al., 2013–2015) rerendered the metaphor in Minecraft. M3tricity (Pfahler et al. 2020) is the web revival. **Why they often fail in practice:** (1) occlusion — tall god-class buildings hide the district behind them (Wettel 2007 already flags this); (2) the third dimension is spent on a metric you could have mapped to color, leaving no room for relationships; (3) navigation disorientation (Wettel/Lanza argue the city metaphor is supposed to *fix* this relative to floating 3D graphs, and it does, but "orbit the city" is still worse than a 2D treemap + click); (4) relationships as 3D edges recreate the hairball in extra dimensions; (5) spatial memory dies the moment the layout algorithm reshuffles districts. 3D is a demo. 2.5D (treemap with height as a bar, CodeCharta's "buildings" on a 2D floorplan viewed from a fixed isometric camera) is the compromise that sometimes ships.

**Dark-theme terminal-coded dashboards.** Not academic. This is the industrial aesthetic that actually sits next to `htop`, `git log --graph`, and Grafana: `#0a0a0a` ground, a single accent (lime, amber, or red), monospace for paths and counts, no decoration. It works because (a) it matches the editor the user will jump into, (b) it spends contrast on *data*, (c) it refuses the "health score" donut. SeeSoft was already this: reduced representation, color is the statistic, click through to source. A 2026 dashboard that wants to be used should look more like SeeSoft/htop than like a BI executive summary.

---

## 4. What FAILS (with the specific reason)

| Failure | Why it fails | Canonical example |
|---|---|---|
| Comment-ratio / comment-to-code dashboards | Comments are not quality; generated headers and license banners dominate; a well-named function with zero comments outscores a lying comment | Understand and SourceMonitor still expose this metric; it should never be a default color |
| Cyclomatic complexity as a score without a *where* | McCabe 1976 is a testability proxy for a *procedure*. Averaging it to a repo, or flagging every `switch` on an enum, produces queue-of-shame PRs. Without churn, coverage, and size, CC is trivia | SonarQube "Cognitive Complexity" issues on generated code; lizard/radon CLI totals |
| 3D flythroughs | Occlusion, disorientation, poor selection, no overview-first, layout instability | SoftVis city tools used as "explore" rather than "query"; VR CodeCity studies that lose to a 2D screen for outlier-finding (Fittipaldi/Merino-type results: desktop fastest for outliers) |
| Hairball node-link graphs | Force-directed layout is not a coordinate system (Krzywinski 2011: not reproducible, not comparable, not perceptually uniform). Beyond ~150 nodes with mean degree >3 you cannot read paths | `madge .` on a real app; Gephi ForceAtlas2 of a package graph; Graphviz `fdp` of 2k files |
| Pie / gauge of a "health score" | Compresses orthogonal failure modes (security, duplication, coverage, complexity, ownership) into one number that cannot be acted on. Incentivizes metric-gaming (delete comments, add trivial tests) | SonarQube Maintainability Rating as a letter; any "code health %" that is a weighted sum |
| Animation as analysis | You cannot compare frame 12 to frame 40. Gource is a trailer, not an instrument (Tversky et al. 2002) | Gource at a sprint review; code_swarm as a "see the project" ritual |
| UML of the whole system | Class diagrams were a *design* notation. Reverse-engineered UML of 400 types is an unread wallpaper. Sequence diagrams explode with async/callbacks | Understand/Enterprise Architect "generate UML from project" |
| Coverage % as a quality gate on *all* code | Treats dead and live the same; treats generated and essential the same | Sonar quality gate on overall coverage after a directory move (known empty-chart / "new code" confusion in community threads) |
| Unstable layouts | If the treemap/city/graph reshuffles every run, you cannot use spatial memory. Squarified treemaps already jitter when one file grows | Any vis that doesn't pin a layout key (path-sorted slice-and-dice is stabler than squarified) |

**The hive-plot lesson (Krzywinski, Birol, Jones, Marra, *Briefings in Bioinformatics* 2011):** if you must show a large graph, *assign nodes to axes by a structural rule* (e.g. UI / domain / infra, or in-degree tertiles) and sort along the axis by a second rule (e.g. instability). Then two runs of the same system are comparable. Hairballs are not.

---

## 5. Historical spine (1980s–2020s) — the tools named in the brief

A compact chronology so the 20 concepts below have a shelf.

| Year | Artifact | What it actually did |
|---|---|---|
| 1976 | McCabe cyclomatic complexity | Edges − nodes + 2p on a CFG; a *procedure* testability number |
| 1981 | Steward, Design Structure System / DSM | Square matrix of interdependences; partition to expose iteration |
| 1986 | Furnas fisheye | Focus+context as a degree-of-interest function |
| 1988–93 | Graphviz / dot (Koutsofios, North, Gansner, AT&T) | Hierarchical layered digraphs; still the backend for madge |
| 1991 | Johnson & Shneiderman treemaps (Viz '91); TreeViz | Slice-and-dice space-filling hierarchy; born to find large files on a shared Mac disk |
| 1992 | Eick, Steffen, Sumner, SeeSoft (TSE 18(11)) | Each line → a thin row; indent preserved; color = age/author/stat; ~50kLOC on one screen; click through to source |
| 1992 | Jacobson sequence diagrams in OOSE; UML 0.8–1.0 coalesces 1995–97 | Interaction-over-time; reverse-engineered they do not scale |
| 1994 | Martin, OO Design Quality Metrics | Ca, Ce, I, A, main sequence, Dn, zones of pain/uselessness |
| 1995 | Baker, parameterized duplication (WCRE) | Token-parameterized clones; ancestor of CPD |
| 1998 | Rieger, Ducasse, Duploc | Line×line dot-plot; clone = diagonal streak |
| 2000 | Bruls, Huizing, van Wijk, squarified treemaps | Better aspect ratios; less stable layouts |
| 2001 | Lanza, Evolution Matrix (IWPSE); Class Blueprint (OOPSLA) | Class×version polymetric matrix; layered internal call-graph of a class |
| 2002 | Kamiya et al., CCFinder (TSE); Lanza Evolution Matrix journal form | Token-suffix-tree clones; Gemini scatterplots |
| 2003 | Lanza & Ducasse, Polymetric Views (TSE); CodeCrawler | 5 metrics on a node (w, h, x, y, color); System Complexity view |
| 2005 | Balzer/Deussen/Lewerentz Voronoi treemaps (SoftVis); Nagappan/Ball relative churn (ICSE) | Polygon treemaps; churn as defect predictor |
| 2006 | Holten, Hierarchical Edge Bundles (TVCG) | Adjacency on a hierarchy as B-splines along the inclusion path |
| 2007 | Diehl textbook; Wettel/Lanza CodeCity (VISSOFT); Jiang et al. Deckard (ICSE); Livieri et al. D-CCFinder heatmaps | The field's three-way split; 3D cities; AST-vector clones; clone-coverage heatmaps of Linux |
| 2008 | Roy/Cordy NiCad; Ogawa/Ma code_swarm | Parser-based clones + live scatterplots; organic commit animation |
| 2009–10 | Caudwell, Gource (SOFTVIS film 2010) | Animated directory tree, developers as moving dots |
| 2011 | Gregg Flame Graphs; Krzywinski hive plots; Wettel et al. CodeCity ICSE experiment | The two encodings that actually scaled; cities beat Excel on comprehension tasks |
| 2012 | Eppinger & Browning, *DSM Methods and Applications* | Industrial DSM cookbook |
| 2013 | Zaninotto CodeFlower (d3, Gource/code_swarm-inspired); CodeMetropolis (Minecraft) | Pretty LOC flowers; gamified cities |
| 2015 | Tornhill, *Your Code as a Crime Scene*; CodeScene productized | Hotspot = churn ∩ complexity; knowledge maps; change coupling |
| ~2013– | Structure101 LSM, Lattix DSM rules, NDepend DSM+CQLinq, JArchitect, Understand graphs, SonarQube measures/treemaps, Sourcegraph search+nav | The industrial stack a staff engineer actually opens |
| 2016 | Avelino truck factor (ICPC); Gregg CACM flame-graph paper | Knowledge concentration becomes a computed number |
| 2017– | dependency-cruiser (Sander), madge (regular use), Gephi for one-off architecture posters | JS/TS cycle enforcement vs. cycle *drawing* |
| 2018– | LSIF (Microsoft, LSP-adjacent); tree-sitter everywhere | Precise nav indexes; error-tolerant ASTs as a data source |
| 2021–22 | Sourcegraph SCIP (Protobuf symbols, not LSIF integer-ID graphs) | Human-readable symbol IDs; rust-analyzer among producers |
| 2023–26 | Copilot usage dashboards; rebMap / Symphony agent-edit maps; cgraph / code-review-graph MCP; ast-grep; Deslop MCP `find-similar` | The AI-era overlay: *who/what is editing*, not just what the compiler sees |

**Industrial tools, what they are actually good at (not their marketing):**

- **SonarQube** — issue queue + quality gate on *new* code. Visualizations (risk scatter, coverage treemap) are secondary and easy to misread. Dropped native DSM. Use as a finding list, not as a map.
- **CodeScene** — the hotspot map *is* the product. Knowledge maps and change-coupling are the features that static analyzers lack. Code Health as a scalar is the part to treat skeptically.
- **Sourcegraph** — search and precise nav (SCIP). Not a health vis. The graph is in the index, not on the page.
- **CodeQL** — variant analysis over a database of AST + dataflow. Visualization is a path graph *per finding*, excellent; whole-program graphs, no. MRVA (2023) scales the query, not the picture.
- **Understand (SciTools)** — best-in-class *ego* graphs (butterfly, calls, called-by, control flow, UML of *a* class). Metrics treemap is a SeeSoft grandchild. Comment-ratio and HIS suites are for certification theatre.
- **NDepend / JArchitect** — DSM + CQLinq. The DSM coloring (blue = uses, green = used-by, black = mutual) is one of the few industrial encodings a new user can learn in two minutes. Main-sequence scatter is built in.
- **Structure101** — Levelized Structure Map: a layered box diagram where *upward* dependencies are the violations. Spec overlays are the contract genre. Not a DSM tool.
- **Lattix** — DSM-native architecture control; partitioning algorithms; rules in CI. Closest industrial descendant of Steward.
- **dependency-cruiser** — *rules* ("`cli` must not import `packages/agi-cli`") plus an HTML graph that is usable because it is *grouped and hover-lit*, not because force layout is good. Fail the build; glance at the SVG.
- **madge** — the 30-second cycle check. `--circular` + Graphviz. Stops being a vis at ~200 modules.
- **Graphviz/dot** — the rendering engine, not a method. Layered `dot` is the right layout for *acyclic* call/module graphs of modest size; `fdp`/`neato` are how hairballs are born.
- **Gephi** — exploratory network analysis. Fine for "are there communities?" via modularity coloring. Not a daily software tool.
- **Gource / CodeFlower** — communication, onboarding trailer, conference talk. Do not use to pick a refactor.
- **GitHub Insights** — contribution calendar (SeeSoft's age coloring, 365 days, one pixel per day, the most widely deployed software vis in history) and Pulse. Tells you *who is alive*, not whether the code is.
- **SourceMonitor, CLOC, lizard, radon** — tables. CLOC's language breakdown is the one vis (a bar of languages) anyone needs from them. lizard/radon CC lists are input to a hotspot map, not a vis themselves.

---

## 6. AI-era approaches (2022–2026)

The new data sources are not metrics. They are **indexes** and **traces of work**.

**Indexes as graphs.** tree-sitter gives an error-tolerant CST per file; ast-grep (`sg`) queries it structurally ("find every `try` whose `except` is `pass`"). SCIP (Sourcegraph 2022) and the older LSIF give *precise* symbol occurrence, definition, reference, implementation — produced by rust-analyzer, scip-typescript, scip-python, scip-java, etc. tsserver and rust-analyzer *are* already graphs; visualization has mostly not caught up, because the IDE only exposes ego-queries (go-to-def, find-refs). cgraph (Ramachandrajoshi/Code-Graph) and code-review-graph (tirth8205) persist a tree-sitter graph and serve it over MCP so an agent asks `callers(X)` instead of grepping. That is the right split: **the vis for the human is still an ego-butterfly or a DSM; the vis for the agent is a query API.**

**Copilot-usage heatmaps.** GitHub's enterprise Copilot usage dashboard (28-day adoption, feature, model, language; NDJSON export) is organizational, not spatial. Local tools (Copilot Insight, Copilot Usage Viewer) parse `exthost.log` / chat session files into GitHub-style calendars, acceptance-rate timelines, KPM vs. completions scatter, *and sometimes an activity heatmap by hour*. None of these yet overlay *onto the file tree*. The missing vis is SeeSoft coloring by "fraction of current lines first inserted by an agent" or "acceptance rate of completions in this file." That number would tell you where the codebase is becoming synthetic — a new risk genre.

**Agent-edit traffic.** rebMap (VS Code): files as circles, pulse on read/edit, heatmap of touch-count across sessions, click-for-diff, camera follows the agent. Symphony: multi-agent collision board (two agents about to edit the same file) plus a 3D "constellation" that should be treated as a demo; the useful part is the collision panel and the blast-radius graph. This is Gource where the "developer" is an agent and the time window is one session. For a control plane (the thing this repo is), **the collision + blast-radius view is the one to steal**, not the constellation.

**LLM-assisted architecture maps.** Several 2024–2026 tools ask a model to name "zones" (Symphony's plain-English zones; various "architecture overview" MCP tools that cluster by directory then caption). This is dangerous when the LLM invents layers the code does not have. Safe pattern: **cluster by a deterministic graph (imports, SCIP packages, directory), then ask the LLM only for labels and critiques**, never for edges.

**Clone-for-agents.** Deslop's MCP `find-similar` before the agent writes a helper is the first clone vis whose *primary user is not a human*. The human UI (cluster list, dual diff against canonical) is the 1998 Gemini pattern. The new requirement is a machine-readable cluster with a canonical occurrence, a similarity bucket (identical / near / structural), and a "safe to extract?" bit.

---

## 7. Eighteen named visualization concepts

Each concept is something you could prototype. "Why a human would actually use it" is the filter; if that paragraph is weak, do not build it.

### C1. SeeSoft Age-and-Churn Strip

- **Genre:** Evolution + Risk
- **Question:** Where is the code that is both old-in-place and still being patched? Where did last week's work actually land?
- **Data:** Per-line blame (or per-line last-modified), file boundaries, indent; optionally language-server "is comment/string."
- **UI sketch:** One column per file, files grouped by directory, each source line a 1-px row whose length follows indent+line-length (Eick 1992 exactly). Color: diverging, blue = untouched for 12 months, yellow = this quarter, red = this week. A second mode colors by author (capped at 8 hues + "other"). Hover shows path:line and date; click opens the editor at that line. A minimap of the columns is the overview; the editor is the detail.
- **Failure modes:** Generated files and lockfiles steal the red. Must filter by glob. Line-level blame is slow; cache. Reformats paint a file red without semantic change — pair with a "ignore whitespace/format-only commits" switch (CodeScene learned this).
- **Why use it:** A tech lead doing Friday review: "did the agent actually touch the authn module or did it thrash tests?" Faster than `git log -p`. Direct descendant of the most cited software vis paper (Eick et al., TSE 1992).

### C2. Mass Treemap (stable slice-and-dice)

- **Genre:** Structure
- **Question:** Where is the mass? Which directory is the real system?
- **Data:** File tree + a size metric (ncloc from CLOC/tokei, not raw bytes). Optional color: coverage, CC max, or owner.
- **UI sketch:** Slice-and-dice (Johnson/Shneiderman 1991), **path-sorted, not squarified**, so layout is stable across days. Directories are nested rectangles with 1-px padding. Labels only on rectangles that fit. Click to zoom (semantic: next level of names). Color is a single sequential scale, legend required.
- **Failure modes:** Squarified looks nicer and destroys spatial memory. Coloring by a second size-like metric (complexity) double-encodes. Tiny files vanish — that is OK; this view is not a file finder.
- **Why use it:** Onboarding and "where do I start." The HCIL origin story was a full disk; the software analog is a monorepo where `cli/src/lib` is 80% of the product and newcomers wander `packages/`.

### C3. Package Icicle + Bundled Coupling

- **Genre:** Structure
- **Question:** How does containment relate to communication? Which sibling packages should not talk?
- **Data:** Directory/package tree; import/using edges with weights (symbol-count from SCIP or file-count from madge).
- **UI sketch:** Icicle (root at top) occupying the left 40%. Holten hierarchical edge bundles (TVCG 2006) drawn on a radial view of the same tree on the right, or as splines over the icicle. Bundle strength slider: 0 = raw hairball, 1 = only inter-district trunks. Hovering a package lights its incoming/outgoing bundles and dims the rest (dependency-cruiser HTML already does a version of this).
- **Failure modes:** At full bundle strength you only see the trunks you already knew (`cli` → `lib`). At zero you have a hairball. Default ~0.7. Dynamic `import()` and string-based DI are invisible unless the indexer sees them (CodeQL/Understand do; madge does not).
- **Why use it:** Architecture review. This is the honest replacement for "draw me a microservice diagram." Holten's informal user eval and the Telea et al. VISSOFT 2009 C/C++ call-graph study are why bundles beat Tulip force layouts on large call graphs.

### C4. Layered DSM (the N-squared that architects keep)

- **Genre:** Structure + Contracts
- **Question:** What are the layers, where are the cycles, which cell is the illegal coupling?
- **Data:** A chosen grain (packages, or types inside one package). Directed deps with weights. An optional *intended* layer order (from a Structure101-like spec or a `layers.yml`).
- **UI sketch:** Square matrix, same order on rows and columns, intended layers as heavy grid lines. Cells: empty = 0, sequential color = weight, **black = mutual/cycle** (NDepend's scheme). Reorder by: (1) intended layers, (2) within layer, Tarjan SCC then topological. Click a cell → list of concrete edges → click-through to source. A tiny sparkline of "illegal cells over time" under the matrix (contract genre).
- **Failure modes:** Wrong grain (5000 files) makes labels unreadable — cap at ~150 or make it collapsible like NDepend/Lattix hierarchical DSM. Wrong order hides the triangle of cycles. Never let a force layout pick the order.
- **Why use it:** This is the only system-scale coupling view that remains readable. Steward 1981, Lattix, NDepend, IntelliJ's DSM. Structure101's LSM is the friendlier cousin when you already know the layers.

### C5. Hive Plot of Declared Layers

- **Genre:** Structure
- **Question:** Are the intended layers actually acyclic, and which nodes are the bridges?
- **Data:** Same as C4, plus a partition of nodes into 3–6 layers (UI, app, domain, infra, lib, test).
- **UI sketch:** One radial axis per layer, nodes sorted along the axis by Ca (fan-in) or I (instability). Edges only between adjacent axes plus a "illegal skip" color for non-adjacent. Repeat-axis trick (Krzywinski) to show intra-layer edges. Small multiples: one hive per subsystem.
- **Failure modes:** More than ~6 axes becomes a circular hairball. Partition must be *declared*, not clustered, or you are just admiring the clustering algorithm.
- **Why use it:** When you need to *compare* two versions of the architecture (perceptually uniform — the whole point of hive plots vs. Gephi). Diff two hives side by side after a refactor.

### C6. Cycle Extractor (SCC small multiples)

- **Genre:** Structure
- **Question:** What are the actual cycles, ranked by how much they would cost to break?
- **Data:** Directed module graph; Tarjan/Kosaraju SCCs; edge weights; optional git co-change as a second weight.
- **UI sketch:** Do **not** show the whole graph. Show a ranked list of SCCs with size ≥ 2. Each SCC is a small node-link diagram (now N is 2–15, node-link is legal) with a suggested *tear* edge highlighted (the edge whose removal acyclicizes at lowest weight — DSM tearing). madge `--circular` is the CLI ancestor; Lattix/DSM-Optimizer are the industrial ones.
- **Failure modes:** Showing one giant SCC of 200 files (a fully tangled core) as a graph. Fall back to a DSM of *just that SCC*.
- **Why use it:** Cycle meetings. dependency-cruiser fails CI; this view tells you which import to invert.

### C7. Clone Scatterplot + Dual Tree

- **Genre:** Similarity
- **Question:** Where are the clone families, and is this pair extractable?
- **Data:** Clone pairs/classes from a detector that you can swap: CPD/jscpd (Type-1), CCFinder-like tokens (Type-2), NiCad/Deckard/tree-sitter subtree hash (Type-3). File order that respects directory locality.
- **UI sketch:** Two linked panes. **Top:** Duploc/Gemini file×file scatterplot (Rieger 1998; Gemini 2002). Dots on the diagonal are same-file clones; off-diagonal squares are cross-file families. **Bottom:** dual file trees (the two sides of a selected pair) with similarity % on the connecting edge, plus a VS-Code-style diff against a canonical occurrence (Deslop 2020s pattern). Brushing on the scatterplot filters the trees.
- **Failure modes:** Min-token threshold too low → brace-and-import noise. Too high → missed 8-line helpers. Generated code. Type-4 semantic clones need embeddings and will false-positive on "all HTTP handlers look alike."
- **Why use it:** The only vis that both *finds* (scatterplot) and *decides* (diff). Humans will not extract from a CSV of clone pairs.

### C8. Type-Usage Matrix (dead columns, god rows)

- **Genre:** Usage + Structure
- **Question:** Who uses whom? What is dead? What is the accidental public API?
- **Data:** SCIP/LSIF or tsserver/rust-analyzer: for each exported symbol, reference counts by file or by package. Distinguish test vs. prod references.
- **UI sketch:** Rows = exported types/functions (grouped by package, collapsible). Columns = using packages. Cell = reference count. Empty row (no prod refs) = dead-or-test-only, colored with a hatch. Dense column = a package that depends on everything (the app entry, or a god). A toggle hides re-exports (`export *`) so barrels don't look like real fan-in.
- **Failure modes:** Reflection, string names, DI containers undercount. Re-export barrels overcount. Must use *precise* index (SCIP), not grep.
- **Why use it:** API audits and "can I delete this." NDepend CQLinq in visual form. An agent should query the same matrix before introducing a new exported type.

### C9. Butterfly Ego-Graph (Understand-style)

- **Genre:** Usage
- **Question:** If I change *this* function, what is the blast radius? Who calls me, whom do I call?
- **Data:** Precise call/reference graph, 1–2 hops. Distinguish test callers. Optional coverage on nodes.
- **UI sketch:** Selected node center, callers left, callees right (butterfly). Depth stepper 1/2/3. Nodes sized by LOC or CC, colored by hotspot score (C13). Click pushes a new center (browsing). This is SciTools Understand's best graph and Sourcegraph find-refs with a picture.
- **Failure modes:** Depth 3 on a utility (`Optional.map`) is the whole program. Cap by "interesting" (non-std, non-generated) and by hop. Function pointers/virtual dispatch need Understand/CodeQL-quality edges; tree-sitter will guess wrong (cgraph's `--upgrade` via LSP is the right mitigation).
- **Why use it:** Every refactor and every agent edit. Symphony's blast-radius pane is this. Ship this before any city.

### C10. Flame Graph of Runtime (and a sibling: coverage icicle)

- **Genre:** Usage
- **Question:** What actually burns CPU / what is actually tested?
- **Data:** Folded stacks from perf/pprof (Gregg 2011); or, for the sibling, a coverage tree (package→file→function) with hit counts.
- **UI sketch:** Classical flame graph, interactive SVG, search highlight. Sibling: icicle of the source tree colored by hit-count, not by "covered? yes/no" — because a function hit once in a smoke test and a function on the request hot path must not look the same.
- **Failure modes:** Putting wall-clock time on x in a sampling flame graph (Gregg's #1 misreading). Coverage icicle that uses binary covered/uncovered (Sonar treemap sin).
- **Why use it:** Performance incidents (flame), and test-value arguments (icicle). The latter is how you stop worshipping 90% coverage.

### C11. Class Blueprint / Polymetric System Complexity

- **Genre:** Structure
- **Question:** What is the shape of this class / which classes are god, data, or shotgun?
- **Data:** Methods, attributes, invocations, accessors; NOM, NOA, LOC.
- **UI sketch:** Two scales. **System:** Lanza/Ducasse System Complexity (TSE 2003) — inheritance tree, each class a rectangle, width = attributes, height = methods, color = LOC. Gods, data classes (wide and short), and tiny leaves pop. **Class:** Class Blueprint (OOPSLA 2001) — layers left-to-right: init, interface, implementation, accessor, attribute; edges are calls/accesses; node size = LOC. "Schizophrenic" classes (two unrelated call forests) show as disconnected components in the implementation layer.
- **Failure modes:** Doesn't map cleanly to Go/Rust (no classes) — use file or type. Accessors in modern code are often trivial and should be elided.
- **Why use it:** First two hours on a foreign OO system. Still the fastest "what's wrong with this type" vis.

### C12. Main-Sequence Scatter (Zone of Pain callout)

- **Genre:** Risk + Structure
- **Question:** Which packages are stable-and-concrete (pain) or abstract-and-unused (useless)?
- **Data:** Per-package Ca, Ce, I, A, Dn (Martin 1994). Size = ncloc. Highlight packages with high Ca.
- **UI sketch:** X = I (0..1), Y = A (0..1), diagonal A+I=1, shaded Zone of Pain (bottom-left) and Zone of Uselessness (top-right). Each package a point; area = ncloc; label the outliers only. Click → C4 DSM filtered to that package's neighbors. **Do not** show mean Dn as a KPI.
- **Failure modes:** Defining "abstract" in Python/Go (no interfaces vs. protocols). Package grain too fine (every file a package) or too coarse (one package). JDepend-on-Java is the original sweet spot; NDepend still ships this.
- **Why use it:** Architecture steering committee, twice a year. Not a daily view. The action is: invert a dependency or extract an interface from a Zone-of-Pain package that everyone imports.

### C13. Hotspot Map (churn × complexity)

- **Genre:** Risk + Evolution
- **Question:** Where does unhealthy code meet actual work?
- **Data:** Git log (commit frequency or relative churn, Nagappan/Ball 2005), file LOC or indentation-complexity (Tornhill), optional defect density / Code Health. Hierarchical file tree.
- **UI sketch:** Circle packing (CodeScene default) or C2 treemap. Area = complexity proxy, color = sequential hot for activity. Table on the right, ranked, with a complexity-trend sparkline (CodeScene 2015–). Combined-aspects toggle: overlay knowledge (C15) or coverage (C10 sibling) as a hatch, not a second hue.
- **Failure modes:** Commit-style bias (micro-commits vs. dumps) — offer relative-churn mode (CodeScene docs). Historical hotspots that have since been rewritten still rank high if you use lifetime commits — window to 90 days for "what now," lifetime for "what always."
- **Why use it:** The refactor backlog. The most empirically defended vis in this list after SeeSoft (churn↔defects). An agent should default to editing *outside* the top-10 hotspots unless the task names them.

### C14. Evolution Matrix (class life stories)

- **Genre:** Evolution
- **Question:** Which types are pulsing, dying, or exploding?
- **Data:** Per-type, per-release (or per-month) NOM/NOA/LOC.
- **UI sketch:** Lanza IWPSE 2001: rows = types (stable identity), columns = versions, each cell a polymetric box. Vocabulary: *newborn*, *dead*, *pulsar* (grow/shrink), *supernova* (explode). Click a row → sparkline + diff of first vs. last.
- **Failure modes:** Renames break identity (need a genealogical heuristic or git-rename detection). Daily columns are too many — monthly/release.
- **Why use it:** "Is `SessionStore` still growing?" Small multiples beat Gource for this question.

### C15. Knowledge Map + Off-boarding Simulation

- **Genre:** Risk + Evolution
- **Question:** Who knows this, and what happens if they leave?
- **Data:** DOA (Fritz 2014) or CodeScene line-authorship; team assignment; CODEOWNERS as a *declared* overlay (do not confuse with observed). Avelino greedy truck-factor algorithm (ICPC 2016).
- **UI sketch:** Same layout as C13 (so spatial memory transfers), color = primary author (max 12 categorical colors + grey other) or team. A sidebar: truck-factor number, the named people, a slider "remove Alice" that desaturates her files and lists newly orphaned hotspots. Authors-treemap (CodeScene) for contribution share.
- **Failure modes:** Bots, formatters, `git mv`, generated code. Line-authorship ≠ expertise (reviewers, design). Must exclude `vendor/` and lockfiles.
- **Why use it:** Org design and vacation risk. Pair with C13: the scary cell is *hotspot ∩ single-owner*.

### C16. Change-Coupling Sankey

- **Genre:** Evolution + Structure
- **Question:** What co-changes that the compiler cannot see?
- **Data:** Pairs of files whose same-commit co-occurrence exceeds a threshold, excluding merges and reverts. Optional: static-import flag so you can hide "already explained by an import."
- **UI sketch:** Sankey (or a DSM ordered by cluster) between directories: width = co-change count. Drill to file pairs. A "not explained by static deps" filter is the whole point.
- **Failure modes:** Mass refactors and renames create a fake all-to-all. Window the history. Binary files.
- **Why use it:** Finding the hidden architecture (proto↔mapper, schema↔DAO). Tornhill's change coupling; D'Ambros logical coupling. An agent about to edit `foo.proto` should be shown `foo_mapper.ts` even if it doesn't import it.

### C17. Contract Overlay (allowed vs. actual)

- **Genre:** Contracts
- **Question:** Which dependencies violate the architecture we said we had?
- **Data:** A declared spec: Structure101 overlays, dependency-cruiser `forbidden` rules, Lattix DSM rules, or a `layers.yml`. The actual graph from C4.
- **UI sketch:** C4 DSM or C3 bundles, with **illegal edges in a single alarm color** and legal edges muted. Count of violations as the only KPI, trended. Click → the rule text ("`cli` must not import `native/`") and the offending import line. This is Structure101 Build + dependency-cruiser, visualized.
- **Failure modes:** Spec that describes the status quo (rules rot). Generate the first spec from the partitioned DSM, then freeze it.
- **Why use it:** The only vis that answers "are we allowed to." An agent must consult this *before* adding an import; humans look at it when CI goes red.

### C18. Agent-Traffic SeeSoft / Collision Board

- **Genre:** Evolution + Risk (AI-era)
- **Question:** Where are agents reading and writing *right now*, where have they concentrated over the last N sessions, and are two agents about to collide?
- **Data:** File-level read/write/create/delete events from agent hooks (Symphony ingest, rebMap local, Cursor session traces), plus git diff hunks, plus C9 blast radius.
- **UI sketch:** Two modes. **Live:** file tree (or C2 treemap) with pulse on active files, agent-id chips, a collision warning when two sessions hold the same file or a C9 neighbor. **Session heatmap:** SeeSoft or treemap colored by "agent-touched lines / total lines" over 7/30 days. Click → diff. Blast-radius preview before a write (Symphony).
- **Failure modes:** 3D constellations (Symphony's pretty mode) and force-flowers (CodeFlower of agent traffic) repeat 2010's mistakes. Telemetry that captures prompts is a secret-retention bug — keep path, op, timestamp, agent-id, diff stats only.
- **Why use it:** Fleet control planes (this repo's actual product space). Humans babysitting many agents need collisions and concentration, not another health donut. Direct descendant of Gource (Caudwell 2010) with the analysis discipline of SeeSoft (Eick 1992) and the ego-graph of Understand.

### C19. Public-Surface Census (API sprawl)

- **Genre:** Contracts + Usage
- **Question:** What do we *promise*, and is the promise growing faster than callers?
- **Data:** Exported symbols (package `index.ts`, `pub use`, Java `public`), each with: age, Ca (callers), changelog / semver hints, deprecated flag.
- **UI sketch:** Icicle of the public namespace. Area = (optionally) caller count, not LOC — a public function with 0 callers is a thin sliver with an alarm hatch. A timeline small-multiple: public-symbol count vs. used-public-symbol count. "New this quarter, 0 callers" is a worklist.
- **Failure modes:** Counting `export type` that exists only for declaration merging. Internal packages published "just in case."
- **Why use it:** Library teams and anyone who has ever regretted a barrel file. Agents love to export helpers "for reuse"; this view is the counter-pressure.

### C20. Copilot/LLM Provenance Heatmap

- **Genre:** Risk + Evolution (AI-era)
- **Question:** Which regions of the tree are increasingly synthetic, and do those regions coincide with hotspots?
- **Data:** Completion accept/reject events if available; more realistically, commit attribution (`Co-authored-by:`, agent trailers), plus C13 hotspot scores. GitHub Copilot usage metrics API is org-level — join it to repo paths via PR files.
- **UI sketch:** C2/C13 layout, color = fraction of current lines from agent-attributed commits (windowed). Overlay C13 as a border thickness. The scary cell: high synthetic fraction × high churn × low coverage (C10 sibling).
- **Failure modes:** Attribution is political and incomplete; bots and humans amend. Do not make this a "shame" dashboard; make it a review-allocation dashboard (put senior review on synthetic hotspots).
- **Why use it:** 2026's new bus factor is "the model plus whoever still understands the module." Pairs with C15.

---

## 8. Design principles — for a human *and* for an AI coding agent

### Shared principles (the vis is a shared artifact)

1. **One question per view.** SeeSoft is age. DSM is coupling. Hotspot is churn×complexity. A view that encodes five metrics on one glyph (city buildings with height, base, color, windows, smoke) is how 3D failed. Polymetric views got away with five only because Lanza defined a *small set of named views*, each with a fixed mapping.

2. **Overview → filter → source.** Every view's selection must land in the editor at a file:line. Eick 1992 already had this; dashboards that cannot click-through are posters.

3. **Stable layout or don't bother.** Spatial memory is the point of a map. Sort by path. Pin DSM order to the declared layer spec. Do not rerun ForceAtlas2.

4. **Node-link is an ego tool; matrices are a system tool.** (Ghoniem 2004 + 20 years of Lattix.)

5. **Show the exception, mute the rule.** Illegal edges, clone families, orphaned hotspots, Zone-of-Pain packages. The healthy 90% should be visually quiet (Tufte: ink for data; also the terminal-coded aesthetic).

6. **Grain is a first-class control.** Package / file / type / line. Default grain by question: architecture = package, clone = function, hotspot = file, SeeSoft = line.

7. **Window the history.** Lifetime churn ≠ last-90-days churn. Make the window a slider, not a footnote.

8. **Separate observed from declared.** CODEOWNERS ≠ DOA. `layers.yml` ≠ import graph. Draw declared as an overlay (C17), never as the only truth.

### Human-specific

9. **Names, not glyphs, at the decision point.** A treemap that only colors is a vibe. The ranked table next to it is why CodeScene is used. Always pair the picture with a worklist.

10. **Categorical color ≤ 8–12.** Knowledge maps that assign a hue per developer on a 40-person team become grey soup. Group by team, then drill.

11. **No composite health score as a primary encoding.** Letters and gauges get gamed and cannot be explained to a skip-level. If you must, show the *vector* (coverage, duplication, hotspot count, truck factor) as small multiples of the same layout.

12. **Dark, sparse, monospace for identifiers.** The user is coming from an editor and going back to one.

### Agent-specific (the vis has a query twin)

13. **Every view is a query.** Humans get C9 as a butterfly picture; agents get `blast_radius(symbol, hops=2, exclude=test)`. Humans get C7 as a scatterplot; agents get `find_similar(snippet) → {canonical, bucket, safe_to_extract}`. If you ship a picture without the query, agents will screenshot it or ignore it.

14. **Write-fences from risk views.** Default policy: do not enlarge C11 god nodes; do not add edges that C17 paints illegal; do not edit top-N C13 hotspots without an explicit task mention; do not introduce a new export without C19. This is Structure101/dependency-cruiser for machines.

15. **Canonical occurrences, not "some match."** Clone, duplication, and "is there already a helper" must return a stable canonical span so the agent diffs against one thing (Deslop). Scatterplots are for humans.

16. **Precise edges when the action is a refactor; approximate edges when the action is search.** SCIP/rust-analyzer/tsserver/CodeQL for blast radius. tree-sitter/ast-grep/madge for hunt. Mixing them silently is how agents "update all callers" and miss a function pointer.

17. **Collision and provenance are first-class.** Multi-agent control planes need C18 the way humans needed `git status`. C20 provenance changes review policy.

18. **Do not let the LLM invent the graph.** Cluster and caption, yes; edges, no. The graph comes from SCIP, git, or the compiler.

19. **Token budget = ego + worklist, never the city.** Dumping a 3D city or a 2000-node GraphML into context is the hairball as text. Return the ranked 10 and the 2-hop neighborhood.

20. **Fail loud at the same boundaries as the human UI.** Unsupported language, missing index, generated-code glob, renamed type breaking C14 identity — error, don't silently grep.

---

## 9. Suggested shortlist for a 10–20 option design exploration

If the exploration can only prototype a handful, this is the historically justified set, covering all six genres without repeating a failure:

| # | Concept | Genre | Ancestor to steal from | Skip if…
|---|---|---|---|---|
| 1 | C1 SeeSoft strip | Evolution | Eick 1992 | you cannot get blame cheaply |
| 2 | C2 Mass treemap | Structure | TreeViz 1991, path-sorted | — |
| 3 | C4 Layered DSM | Structure/Contracts | Steward, Lattix, NDepend | — |
| 4 | C6 Cycle extractor | Structure | madge + DSM tearing | — |
| 5 | C7 Clone scatter + dual tree | Similarity | Duploc, Gemini, Deslop | — |
| 6 | C9 Butterfly | Usage | Understand | — |
| 7 | C10 Flame / coverage icicle | Usage | Gregg 2011 | no runtime/coverage data |
| 8 | C12 Main-sequence scatter | Risk | Martin 1994, NDepend | non-package language without a module grain |
| 9 | C13 Hotspot map | Risk/Evolution | Tornhill 2015, Nagappan 2005 | — |
| 10 | C15 Knowledge map | Risk | Avelino 2016, CodeScene | — |
| 11 | C16 Change-coupling Sankey | Evolution | Tornhill logical coupling | short history |
| 12 | C17 Contract overlay | Contracts | Structure101, dependency-cruiser | no spec yet (then generate from C4) |
| 13 | C18 Agent-traffic board | AI-era | Gource + SeeSoft + Symphony collisions | no agent events |
| 14 | C19 Public-surface census | Contracts | SCIP exports + Ca | — |
| 15 | C3 Icicle + Holten bundles | Structure | Holten 2006 | C4 already answers the meeting |
| 16 | C5 Hive plot | Structure | Krzywinski 2011 | you don't have declared layers |
| 17 | C11 Polymetric / blueprint | Structure | Lanza 2001/2003 | not OO |
| 18 | C8 Usage matrix | Usage | NDepend DSM of *use* | no SCIP |
| 19 | C14 Evolution matrix | Evolution | Lanza 2001 | no type identity over time |
| 20 | C20 Provenance heatmap | AI-era | C13 layout + commit trailers | attribution too sparse |

**Do not prototype:** 3D cities (C as demo only), Gource as analysis, pie health scores, repo-wide UML, Gephi force layouts of the whole program, Voronoi treemaps as a daily view, comment-ratio coloring.

---

## 10. Citations (primary)

- Avelino, G., Passos, L., Hora, A., Valente, M. T. (2016). A novel approach for estimating Truck Factors. *ICPC*.
- Baker, B. S. (1995). On finding duplication and near-duplication in large software systems. *WCRE*.
- Balzer, M., Deussen, O., Lewerentz, C. (2005). Voronoi treemaps for the visualization of software metrics. *SoftVis*.
- Bruls, M., Huizing, K., van Wijk, J. J. (2000). Squarified treemaps. *VisSym*.
- Caudwell, A. H. (2010). Gource. *SOFTVIS* film.
- Diehl, S. (2007). *Software Visualization: Visualizing the Structure, Behaviour, and Evolution of Software*. Springer.
- Eick, S. G., Steffen, J. L., Sumner, E. E. Jr. (1992). SeeSoft—A tool for visualizing line oriented software statistics. *IEEE TSE* 18(11).
- Eppinger, S. D., Browning, T. R. (2012). *Design Structure Matrix Methods and Applications*. MIT Press.
- Ferreira, M. et al. (2017). A comparison of three algorithms for computing Truck Factors. *ICPC*.
- Furnas, G. W. (1986). Generalized fisheye views. *CHI*.
- Gansner, E. R., Koutsofios, E., North, S. C., Vo, K.-P. (1993). A technique for drawing directed graphs. *IEEE TSE* (dot).
- Ghoniem, M., Fekete, J.-D., Castagliola, P. (2004). A comparison of the readability of graphs using node-link and matrix-based representations. *InfoVis*.
- Gregg, B. (2011/2016). Flame graphs. github.com/brendangregg/FlameGraph; *CACM* 59(6).
- Holten, D. (2006). Hierarchical edge bundles. *IEEE TVCG* 12(5).
- Jiang, L., Misherghi, G., Su, Z., Glondu, S. (2007). DECKARD: Scalable and accurate tree-based detection of code clones. *ICSE*.
- Johnson, B., Shneiderman, B. (1991). Tree-maps: a space-filling approach to the visualization of hierarchical information structures. *IEEE Visualization*.
- Kamiya, T., Kusumoto, S., Inoue, K. (2002). CCFinder: A multilinguistic token-based code clone detection system for large scale source code. *IEEE TSE*.
- Krzywinski, M., Birol, I., Jones, S., Marra, M. (2011). Hive plots—rational approach to visualizing networks. *Briefings in Bioinformatics*.
- Lanza, M. (2001). The evolution matrix. *IWPSE*.
- Lanza, M., Ducasse, S. (2001). The class blueprint. *OOPSLA*.
- Lanza, M., Ducasse, S. (2003). Polymetric views. *IEEE TSE* 29(9).
- Martin, R. C. (1994). OO Design Quality Metrics: An Analysis of Dependencies. OOPSLA workshop.
- McCabe, T. J. (1976). A complexity measure. *IEEE TSE*.
- Munzner, T. et al. (2003). TreeJuxtaposer. *SIGGRAPH*.
- Nagappan, N., Ball, T. (2005). Use of relative code churn measures to predict system defect density. *ICSE*.
- Rieger, M., Ducasse, S. (1998). Visual detection of duplicated code. ECOOP workshop.
- Roy, C. K., Cordy, J. R. (2008). NICAD: Accurate detection of near-miss intentional clones using flexible pretty-printing and code normalization. *ICPC*.
- Shneiderman, B. (1996). The eyes have it: A task by data type taxonomy for information visualizations. *VL*. (overview, zoom, filter, details-on-demand)
- Steward, D. V. (1981). The design structure system. *IEEE Trans. Engineering Management* EM-28(3).
- Tornhill, A. (2015). *Your Code as a Crime Scene*. Pragmatic Bookshelf. (CodeScene product thereafter)
- Tversky, B., Morrison, J. B., Betrancourt, M. (2002). Animation: can it facilitate? *Int. J. Human-Computer Studies*.
- Wettel, R., Lanza, M. (2007). Visualizing software systems as cities. *VISSOFT*.
- Wettel, R., Lanza, M., Robbes, R. (2011). Software systems as cities: a controlled experiment. *ICSE*.

**Tools as primary sources:** NDepend DSM docs; Lattix product literature; Structure101 Studio help (LSM + overlays); SciTools Understand graph catalog; SonarQube 8.9/10.x visualization docs; CodeScene hotspot/knowledge-map docs; madge README; dependency-cruiser docs; Sourcegraph SCIP announcement (2022) and `scip/docs/DESIGN.md`; GitHub Copilot usage metrics docs; Gregg flamegraph.com; hiveplot.com.

---

## 11. One-paragraph brief for the design team

Steal SeeSoft's click-through pixel map, Lattix/NDepend's DSM, Holten's bundles, Gregg's flame graph, Tornhill's hotspot, Avelino's knowledge map, and Structure101's *declared vs. actual* overlay. Add an agent-traffic collision board and a SCIP-backed usage matrix. Give every picture a query twin so an AI coding agent can ask the same question without eating a PNG. Do not build a city, a health pie, or a force-directed import graph of the whole repo. The human judges god modules, cycles, coupled clones, theatrical tests, sprawling APIs, dead types, Zone-of-Pain packages, churn×complexity, and bus factor — if the vis cannot make those nine scenes pop, it is decoration.

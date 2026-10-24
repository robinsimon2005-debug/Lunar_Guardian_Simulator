export const SITES = [
  { id: "tranquility", name: "Mare Tranquillitatis", lat: 0.674, lon: 23.473, seed: 1.1 },
  { id: "tycho", name: "Tycho Rim Complex", lat: -43.3, lon: -11.22, seed: 2.4 },
  { id: "copernicus", name: "Copernicus Crater", lat: 9.62, lon: -20.08, seed: 3.7 },
  { id: "aristarchus", name: "Aristarchus Plateau", lat: 23.73, lon: -47.49, seed: 4.2 },
  { id: "procellarum", name: "Oceanus Procellarum", lat: 18.4, lon: -57.4, seed: 5.9 },
];

// Each mission keeps its original id/title/blurb/objectives and gains briefing
// fields (equipment, risks), a "learn" note shown in the debrief, and a short
// knowledge check. Game rules are in game.js; nothing here is mock data.
export const MISSIONS = [
  {
    id: 1,
    title: "Phase 1 · Terrain Data Layering",
    blurb:
      "Evaluate landing and sampling sites with multi-spectral overlays. Toggle layers 1–5 and identify a high Safety Index drill site.",
    objectives: [
      "Toggle at least three spectral layers (keys 1–5)",
      "Locate a low Safety Index (green) drill candidate",
      "Open wrist (R) and mark the candidate with E within 28 m",
    ],
    equipment: ["EVA suit with MMU jetpack", "Sampler MMSEV (remote drill)", "Habitat with solar array and battery"],
    risks: ["Steep or shadowed ground raises the Safety Index", "EVA time outside the habitat adds radiation dose"],
    learn:
      "Slope, illumination and surface roughness all change where a rover can safely work. The Safety Index here blends them with fixed weights (45% slope, 35% shadow, 20% roughness). That is a game heuristic, not a validated NASA safety metric.",
    check: {
      q: "In this game's Safety Index, which terrain factor carries the most weight?",
      options: ["Slope angle", "Shadow (low illumination)", "Surface roughness"],
      answer: 0,
      why: "Slope has the largest weight (0.45). Steep ground is hardest on a rover's drive system and stability.",
    },
  },
  {
    id: 2,
    title: "Phase 2 · Route Optimization",
    blurb:
      "Plan an energy-efficient path from Landing Site Alpha to Target Bravo. Compare Dijkstra shortest path vs terrain-aware safety routing.",
    objectives: [
      "Review both generated routes on the tactical map (M)",
      "Follow the terrain-aware safety path toward Bravo",
      "Arrive within 14 m of Target Bravo",
    ],
    equipment: ["EVA suit with MMU jetpack", "Sampler MMSEV", "Tactical map with route comparison"],
    risks: ["The shortest route may cross steep slopes and shadow", "Longer routes use habitat time and EVA exposure"],
    learn:
      "The shortest route is not always the cheapest. Climbing costs extra rover power per metre, so the map compares distance, slope, shadow, obstacle exposure and estimated battery use for each route.",
    check: {
      q: "A route is longer but avoids steep slopes. Why might it still use less rover energy?",
      options: [
        "Climbing needs more power per metre than flat driving",
        "Shadowed ground makes rovers lighter",
        "Rovers use no power on gentle slopes",
      ],
      answer: 0,
      why: "In this model drive power rises with slope, so a longer flat route can cost less energy than a short steep one.",
    },
  },
  {
    id: 3,
    title: "Phase 3 · Collaborative Rover Team",
    blurb:
      "Coordinate Scout, Mapper, and Sampler MMSEV units. Keep line-of-sight comms and a shared power budget while gathering distributed data.",
    objectives: [
      "Keep the team on a shared power grid with line-of-sight comms",
      "Complete Mapper scan of the central crater rim",
      "Have the Sampler reach CORE-A; let the Scout reveal hidden hazards",
    ],
    equipment: ["Scout, Mapper and Sampler rovers", "Habitat charging pad", "Line-of-sight relay mesh"],
    risks: ["Each rover has a small battery and stops when it is empty", "Terrain can block radio line of sight"],
    learn:
      "Rovers carry limited energy, so long traverses must be planned around recharging at the habitat. Charging draws on the habitat battery, which also runs life support. Power priority (B) decides who gets energy first.",
    check: {
      q: "Why does a rover need to return to the habitat during a long mission?",
      options: [
        "To recharge its battery from the outpost power system",
        "To refuel with propellant for its wheels",
        "To reset the line-of-sight relay",
      ],
      answer: 0,
      why: "Rover batteries are small. Docking lets them draw from the habitat's solar-charged battery, as long as life support is not starved.",
    },
  },
  {
    id: 4,
    title: "Phase 4 · Dynamic Hazard Adaptation",
    blurb:
      "Complete a timed cross-crater run. When the slope collapses, the nav stack will re-route. Manage MMU thermal limits.",
    objectives: [
      "Begin the timed traverse toward the far rim",
      "Survive the mid-mission slope collapse / boulder slide",
      "Reach the far beacon before the clock expires",
    ],
    equipment: ["EVA suit with MMU jetpack", "Sampler MMSEV with re-route capability", "Habitat radiation shelter"],
    risks: ["Slope collapse blocks the planned route", "A solar particle event raises radiation dose on the surface"],
    learn:
      "Space weather is a real planning constraint. In this game a solar particle event multiplies the dose rate outside the habitat; the shelter keeps the dose far lower. The numbers are gameplay values, not NASA dose limits.",
    check: {
      q: "During a solar particle event, where should the crew be?",
      options: ["Inside the shielded habitat", "On open ground to watch the sky", "Beside a parked rover"],
      answer: 0,
      why: "Shielding reduces radiation dose. Mass between the crew and the particles is the main protection.",
    },
  },
  {
    id: 5,
    title: "Phase 5 · Science Preservation & Reporting",
    blurb:
      "Extract cores with the wrist remote, store them in preservation zones, and export a telemetry report.",
    objectives: [
      "Open the wrist terminal (R) near a science target",
      "Complete a heat-managed extraction (E)",
      "Hold surface contact inside a preservation zone, then export the report",
    ],
    equipment: ["Wrist remote and Sampler MMSEV", "Preservation zones", "Telemetry report export"],
    risks: ["Drilling too hot lowers sample integrity", "Drilling draws extra rover power"],
    learn:
      "Samples are only useful if they stay intact. In this simulation integrity falls as drilling heat rises, and drilling adds load to the rover battery on top of driving.",
    check: {
      q: "What lowers a core sample's integrity in this simulation?",
      options: ["Drilling at high heat", "Driving the rover on flat ground", "Opening the wrist terminal"],
      answer: 0,
      why: "Integrity is computed from the heat reached during extraction, so slow, cool drilling gives a better sample.",
    },
  },
];

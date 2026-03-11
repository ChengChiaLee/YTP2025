// State
let map;
let drawingManager;
let placesService;
let directionsService;
let directionsRenderer;
let selectedRectangle = null;
let routeDrawToken = 0;

const WEIGHT_LIMITS = {
  rating: { min: 0, max: 30, digits: 1 },
  distance: { min: 0, max: 1, digits: 2 }
};

const DEFAULT_SCORING_WEIGHTS = {
  rating: clampNumber(CONFIG.RATING_WEIGHT, WEIGHT_LIMITS.rating.min, WEIGHT_LIMITS.rating.max, 12),
  distance: clampNumber(CONFIG.TRAVEL_WEIGHT, WEIGHT_LIMITS.distance.min, WEIGHT_LIMITS.distance.max, 0.08)
};

const RANDOM_PICK_LIMITS = (() => {
  const topPool = Math.max(0, Math.floor(Number(CONFIG.TOP_RANDOM_POOL) || 0));
  const manualMaxRaw = Number(CONFIG.MAX_MANUAL_PICK_PER_SEGMENT);
  const manualMax = Number.isFinite(manualMaxRaw) && manualMaxRaw >= 0 ? Math.floor(manualMaxRaw) : topPool;
  const max = Math.max(0, Math.min(topPool, manualMax));
  return { min: 0, max };
})();

const DEFAULT_RANDOM_PICK_COUNT = Math.floor(
  clampNumber(
    CONFIG.MAX_RANDOM_PICK_PER_SEGMENT,
    RANDOM_PICK_LIMITS.min,
    RANDOM_PICK_LIMITS.max,
    Math.min(1, RANDOM_PICK_LIMITS.max)
  )
);

const START_TIME_LIMITS = { min: 0, max: 24 * 60 - 1 };
const MEAL_DURATION_LIMITS = { min: 10, max: 180 };
const DEFAULT_START_MINUTE = Math.round(
  clampNumber(CONFIG.DEFAULT_START_MINUTE, START_TIME_LIMITS.min, START_TIME_LIMITS.max, 8 * 60)
);
const DEFAULT_MEAL_DURATION_MIN = Math.round(
  clampNumber(CONFIG.DINING_DURATION_MIN, MEAL_DURATION_LIMITS.min, MEAL_DURATION_LIMITS.max, 50)
);
const DEFAULT_MEAL_DURATIONS = {
  breakfast: DEFAULT_MEAL_DURATION_MIN,
  lunch: DEFAULT_MEAL_DURATION_MIN,
  dessert: DEFAULT_MEAL_DURATION_MIN,
  dinner: DEFAULT_MEAL_DURATION_MIN,
  night: DEFAULT_MEAL_DURATION_MIN
};
const DRIVING_SPEED_M_PER_MIN = Number(CONFIG.DRIVING_SPEED_M_PER_MIN) > 0
  ? Number(CONFIG.DRIVING_SPEED_M_PER_MIN)
  : 500;

const overlays = {
  markers: [],
  circles: [],
  polylines: []
};

const plannerState = {
  bounds: null,
  center: null,
  requiredMeals: [],
  restaurants: [],
  mealBuckets: {
    breakfast: [],
    lunch: [],
    dessert: [],
    dinner: [],
    night: []
  },
  mealPath: [],
  perRestaurantAttractions: {},
  segmentCandidates: [],
  segmentSelections: [],
  scoringWeights: { ...DEFAULT_SCORING_WEIGHTS },
  randomPickCount: DEFAULT_RANDOM_PICK_COUNT,
  startMinute: DEFAULT_START_MINUTE,
  mealDurations: { ...DEFAULT_MEAL_DURATIONS },
  stopSchedule: []
};

const MEAL_SLOTS = {
  breakfast: { key: "breakfast", label: "早餐", start: 7 * 60, end: 10 * 60 },
  lunch: { key: "lunch", label: "午餐", start: 11 * 60, end: 14 * 60 },
  dessert: { key: "dessert", label: "甜點", start: 14 * 60, end: 17 * 60 },
  dinner: { key: "dinner", label: "晚餐", start: 17 * 60 + 30, end: 21 * 60 },
  night: { key: "night", label: "消夜", start: 21 * 60, end: 24 * 60 - 1 }
};

const MEAL_ORDER = ["breakfast", "lunch", "dessert", "dinner", "night"];

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.innerText = text;
}

function explainPlacesStatus(status) {
  if (status === google.maps.places.PlacesServiceStatus.REQUEST_DENIED) {
    return "Places API 被拒絕。請確認：已啟用 Billing、已啟用 Maps JavaScript API + Places API、API Key 的 HTTP referrer 包含目前網址。";
  }
  if (status === google.maps.places.PlacesServiceStatus.OVER_QUERY_LIMIT) {
    return "超過查詢配額，請稍後再試或調降查詢量。";
  }
  if (status === google.maps.places.PlacesServiceStatus.INVALID_REQUEST) {
    return "Places 請求參數無效。";
  }
  if (status === google.maps.places.PlacesServiceStatus.NOT_FOUND) {
    return "找不到對應地點資料。";
  }
  return `Places API 失敗: ${status}`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function minuteToLabel(minute) {
  const m = Math.max(0, Math.round(minute));
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function minuteToTimeInputValue(minute) {
  const safeMinute = Math.round(
    clampNumber(minute, START_TIME_LIMITS.min, START_TIME_LIMITS.max, DEFAULT_START_MINUTE)
  );
  const h = Math.floor(safeMinute / 60) % 24;
  const mm = safeMinute % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function timeInputToMinute(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return null;
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
  return hours * 60 + mins;
}

function hhmmToMinute(hhmm) {
  if (!hhmm || hhmm.length < 3) return null;
  const hours = Number(hhmm.slice(0, 2));
  const mins = Number(hhmm.slice(2, 4));
  if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
  return hours * 60 + mins;
}

function placeLoc(place) {
  if (!place || !place.geometry || !place.geometry.location) return null;
  const loc = place.geometry.location;
  return {
    lat: typeof loc.lat === "function" ? loc.lat() : loc.lat,
    lng: typeof loc.lng === "function" ? loc.lng() : loc.lng
  };
}

function placeIdentityKey(place) {
  if (!place) return "unknown:";
  if (place.place_id) return `pid:${place.place_id}`;

  const loc = placeLoc(place);
  if (loc) {
    return `geo:${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}:${String(place.name || "")}`;
  }

  return `name:${String(place.name || "")}`;
}

function boundsAreaKm2(bounds) {
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const nw = new google.maps.LatLng(ne.lat(), sw.lng());
  const se = new google.maps.LatLng(sw.lat(), ne.lng());
  const path = [nw, ne, se, sw, nw];
  const areaM2 = google.maps.geometry.spherical.computeArea(path);
  return areaM2 / 1_000_000;
}

function clearOverlays() {
  overlays.markers.forEach((x) => x.setMap(null));
  overlays.circles.forEach((x) => x.setMap(null));
  overlays.polylines.forEach((x) => x.setMap(null));
  overlays.markers = [];
  overlays.circles = [];
  overlays.polylines = [];
  if (directionsRenderer) directionsRenderer.set("directions", null);
}

function resetPlannerStateKeepBounds() {
  plannerState.requiredMeals = [];
  plannerState.restaurants = [];
  plannerState.mealBuckets = { breakfast: [], lunch: [], dessert: [], dinner: [], night: [] };
  plannerState.mealPath = [];
  plannerState.perRestaurantAttractions = {};
  plannerState.segmentCandidates = [];
  plannerState.segmentSelections = [];
  plannerState.stopSchedule = [];
}

function getRequiredMeals() {
  // Function 2: 決定哪些餐需要
  return MEAL_ORDER.filter((meal) => {
    const cb = document.querySelector(`input[data-meal='${meal}']`);
    return cb ? cb.checked : false;
  });
}

function setWeightLabel(elementId, value, digits) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = Number(value).toFixed(digits);
}

function syncRandomPickCountFromControls() {
  const randomPickInput = document.getElementById("random-pick-count");
  const countRaw = clampNumber(
    randomPickInput ? randomPickInput.value : plannerState.randomPickCount,
    RANDOM_PICK_LIMITS.min,
    RANDOM_PICK_LIMITS.max,
    plannerState.randomPickCount
  );
  const count = Math.floor(countRaw);

  plannerState.randomPickCount = count;
  if (randomPickInput) randomPickInput.value = String(count);
  setWeightLabel("random-pick-count-value", count, 0);
}

function syncScoringWeightsFromControls() {
  const ratingInput = document.getElementById("rating-weight");
  const distanceInput = document.getElementById("distance-weight");

  const rating = clampNumber(
    ratingInput ? ratingInput.value : plannerState.scoringWeights.rating,
    WEIGHT_LIMITS.rating.min,
    WEIGHT_LIMITS.rating.max,
    plannerState.scoringWeights.rating
  );
  const distance = clampNumber(
    distanceInput ? distanceInput.value : plannerState.scoringWeights.distance,
    WEIGHT_LIMITS.distance.min,
    WEIGHT_LIMITS.distance.max,
    plannerState.scoringWeights.distance
  );

  plannerState.scoringWeights = { rating, distance };
  if (ratingInput) ratingInput.value = String(rating);
  if (distanceInput) distanceInput.value = String(distance);

  setWeightLabel("rating-weight-value", rating, WEIGHT_LIMITS.rating.digits);
  setWeightLabel("distance-weight-value", distance, WEIGHT_LIMITS.distance.digits);
}

function mealDurationFor(mealKey, source = plannerState.mealDurations) {
  return Math.round(
    clampNumber(
      source ? source[mealKey] : DEFAULT_MEAL_DURATION_MIN,
      MEAL_DURATION_LIMITS.min,
      MEAL_DURATION_LIMITS.max,
      DEFAULT_MEAL_DURATION_MIN
    )
  );
}

function syncTimeSettingsFromControls() {
  const startInput = document.getElementById("start-time");
  const parsedStart = timeInputToMinute(startInput ? startInput.value : "");
  const startMinute = Math.round(
    clampNumber(
      parsedStart == null ? plannerState.startMinute : parsedStart,
      START_TIME_LIMITS.min,
      START_TIME_LIMITS.max,
      plannerState.startMinute
    )
  );
  plannerState.startMinute = startMinute;
  if (startInput) startInput.value = minuteToTimeInputValue(startMinute);

  const nextDurations = { ...plannerState.mealDurations };
  MEAL_ORDER.forEach((meal) => {
    const input = document.getElementById(`meal-duration-${meal}`);
    const next = mealDurationFor(meal, { ...nextDurations, [meal]: input ? input.value : nextDurations[meal] });
    nextDurations[meal] = next;
    if (input) input.value = String(next);
  });
  plannerState.mealDurations = nextDurations;
}

function placeWeight(place) {
  // Function 4: 景點/餐廳權重（星數）
  return Number(place && place.rating ? place.rating : 0);
}

function sortByWeightDesc(vector) {
  // Function 5: 依權重排序
  return safeArray(vector)
    .slice()
    .sort((a, b) => {
      const diff = placeWeight(b) - placeWeight(a);
      if (diff !== 0) return diff;
      return Number(b.user_ratings_total || 0) - Number(a.user_ratings_total || 0);
    });
}

function shuffle(arr) {
  const cloned = arr.slice();
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

function getTodayIntervalsFromPeriods(periods, bufferMin) {
  if (!Array.isArray(periods) || periods.length === 0) {
    return [];
  }

  const today = new Date().getDay();
  const prevDay = (today + 6) % 7;
  const intervals = [];

  periods.forEach((p) => {
    if (!p || !p.open) return;
    const openDay = Number(p.open.day);
    const closeDay = p.close ? Number(p.close.day) : openDay;
    const openMin = hhmmToMinute(p.open.time) ?? 0;
    const closeMinRaw = p.close ? hhmmToMinute(p.close.time) : 24 * 60;

    if (openDay === today) {
      let close = closeMinRaw ?? 24 * 60;
      if (closeDay !== today || close <= openMin) close += 24 * 60;
      intervals.push([openMin, close]);
    }

    if (openDay === prevDay && closeDay === today && closeMinRaw != null) {
      intervals.push([0, closeMinRaw]);
    }
  });

  if (intervals.length === 0) return [];

  return intervals
    .map(([s, e]) => [s, Math.max(s, e - bufferMin)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
}

function isOpenToday(place) {
  return Array.isArray(place.openIntervals) && place.openIntervals.length > 0;
}

function canArriveAt(place, _minute) {
  return isOpenToday(place);
}

function isRestaurantOperational(place) {
  const rawStatus = String(place && place.business_status ? place.business_status : "");
  const normalized = rawStatus.toUpperCase();
  if (!normalized) return true;
  if (normalized === "CLOSED_TEMPORARILY" || normalized === "CLOSED_PERMANENTLY") return false;
  if (rawStatus.includes("暫停營業")) return false;
  return true;
}

function isLikelyDessertPlace(place) {
  const types = safeArray(place.types);
  const name = String(place.name || "").toLowerCase();
  if (types.includes("bakery") || types.includes("cafe") || types.includes("ice_cream_shop")) return true;
  return /(dessert|cake|coffee|tea|donut|pastry|甜|蛋糕|咖啡|茶)/i.test(name);
}

function isLikelyBreakfastPlace(place) {
  const name = String(place.name || "").toLowerCase();
  const types = safeArray(place.types);
  if (types.includes("cafe") || types.includes("bakery")) return true;
  return /(breakfast|brunch|早餐|早午餐|豆漿|漢堡)/i.test(name);
}

function classifyRestaurants(restaurants, requiredMeals) {
  // Function 3: 分類成五個 vector
  const buckets = {
    breakfast: [],
    lunch: [],
    dessert: [],
    dinner: [],
    night: []
  };

  safeArray(restaurants).forEach((r) => {
    if (!isRestaurantOperational(r)) return;
    if (!isOpenToday(r)) return;

    requiredMeals.forEach((meal) => {
      if (!MEAL_SLOTS[meal]) return;

      if (meal === "dessert" && !isLikelyDessertPlace(r)) {
        if (placeWeight(r) < 3.8) return;
      }

      if (meal === "breakfast" && !isLikelyBreakfastPlace(r)) {
        if (placeWeight(r) < 4.2) return;
      }

      buckets[meal].push(r);
    });
  });

  requiredMeals.forEach((meal) => {
    buckets[meal] = sortByWeightDesc(buckets[meal]).slice(0, CONFIG.MAX_CANDIDATE_PER_MEAL);
  });

  return buckets;
}

function estimateTravelMinutes(fromPlace, toPlace) {
  const fromLoc = placeLoc(fromPlace);
  const toLoc = placeLoc(toPlace);
  if (!fromLoc || !toLoc) return 99999;
  const meters = google.maps.geometry.spherical.computeDistanceBetween(
    new google.maps.LatLng(fromLoc.lat, fromLoc.lng),
    new google.maps.LatLng(toLoc.lat, toLoc.lng)
  );
  return meters / CONFIG.TRAVEL_SPEED_M_PER_MIN;
}

function estimateDrivingMinutes(fromPlace, toPlace) {
  const fromLoc = placeLoc(fromPlace);
  const toLoc = placeLoc(toPlace);
  if (!fromLoc || !toLoc) return 99999;
  const meters = google.maps.geometry.spherical.computeDistanceBetween(
    new google.maps.LatLng(fromLoc.lat, fromLoc.lng),
    new google.maps.LatLng(toLoc.lat, toLoc.lng)
  );
  return meters / DRIVING_SPEED_M_PER_MIN;
}

function edgeCost(u, v, departMinute, slot) {
  // Function 7: cost(u, v)
  const travelMin = estimateTravelMinutes(u, v);
  let arrival = departMinute + travelMin;

  if (arrival > slot.end) {
    return { cost: CONFIG.INF_COST, arrival: null, rawArrival: arrival, travelMin };
  }

  let timePenalty = 0;
  if (arrival < slot.start) {
    timePenalty = slot.start - arrival;
    arrival = slot.start;
  }

  if (arrival > slot.end) {
    return { cost: CONFIG.INF_COST, arrival: null, rawArrival: arrival, travelMin };
  }

  if (!canArriveAt(v, arrival)) {
    return { cost: CONFIG.INF_COST, arrival: null, rawArrival: arrival, travelMin };
  }

  const ratingWeight = plannerState.scoringWeights.rating;
  const distanceWeight = plannerState.scoringWeights.distance;
  const starPenalty = (5 - placeWeight(v)) * ratingWeight;
  const travelPenalty = travelMin * distanceWeight;
  const totalCost = timePenalty + starPenalty + travelPenalty;

  return { cost: totalCost, arrival, rawArrival: arrival, travelMin };
}

class MinHeap {
  constructor() {
    this.arr = [];
  }

  push(item) {
    this.arr.push(item);
    this.bubbleUp(this.arr.length - 1);
  }

  pop() {
    if (!this.arr.length) return null;
    const root = this.arr[0];
    const tail = this.arr.pop();
    if (this.arr.length && tail) {
      this.arr[0] = tail;
      this.bubbleDown(0);
    }
    return root;
  }

  bubbleUp(idx) {
    while (idx > 0) {
      const p = Math.floor((idx - 1) / 2);
      if (this.arr[p].cost <= this.arr[idx].cost) break;
      [this.arr[p], this.arr[idx]] = [this.arr[idx], this.arr[p]];
      idx = p;
    }
  }

  bubbleDown(idx) {
    const n = this.arr.length;
    while (true) {
      let smallest = idx;
      const l = idx * 2 + 1;
      const r = idx * 2 + 2;
      if (l < n && this.arr[l].cost < this.arr[smallest].cost) smallest = l;
      if (r < n && this.arr[r].cost < this.arr[smallest].cost) smallest = r;
      if (smallest === idx) break;
      [this.arr[idx], this.arr[smallest]] = [this.arr[smallest], this.arr[idx]];
      idx = smallest;
    }
  }

  get size() {
    return this.arr.length;
  }
}

function chooseMealPathDijkstra(requiredMeals, mealBuckets, originPlace, options = {}) {
  // Function 8: Dijkstra（分層圖）
  if (requiredMeals.length === 0) return [];
  const startMinute = Math.round(
    clampNumber(
      options.startMinute,
      START_TIME_LIMITS.min,
      START_TIME_LIMITS.max,
      MEAL_SLOTS[requiredMeals[0]].start
    )
  );
  const mealDurations = options.mealDurations || plannerState.mealDurations;
  const getMealDuration = (mealKey) => mealDurationFor(mealKey, mealDurations);

  const layers = requiredMeals.map((meal) => {
    const list = safeArray(mealBuckets[meal]);
    if (list.length === 0) throw new Error(`${MEAL_SLOTS[meal].label} 沒有可用餐廳`);
    return list;
  });

  const source = "src";
  const sink = "sink";

  const dist = new Map();
  const arrivalAt = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  const stateMeta = new Map();
  const stateKeyBySignature = new Map();
  let stateCounter = 0;

  const signatureOf = (stage, idx, usedRestaurantKeys) => `${stage}|${idx}|${JSON.stringify(usedRestaurantKeys)}`;
  const getOrCreateStateKey = (stage, idx, usedRestaurantKeys) => {
    const signature = signatureOf(stage, idx, usedRestaurantKeys);
    const existing = stateKeyBySignature.get(signature);
    if (existing) return existing;

    const key = `n${stateCounter++}`;
    stateKeyBySignature.set(signature, key);
    stateMeta.set(key, { stage, idx, usedRestaurantKeys });
    return key;
  };

  const relax = (fromKey, fromPlace, toStage, toIdx, departMinute, slot, usedRestaurantKeys) => {
    const toPlace = layers[toStage][toIdx];
    const toIdentityKey = placeIdentityKey(toPlace);
    if (usedRestaurantKeys.includes(toIdentityKey)) return;

    const edge = edgeCost(fromPlace, toPlace, departMinute, slot);
    if (edge.cost >= CONFIG.INF_COST || edge.arrival == null) return;

    const toKey = getOrCreateStateKey(toStage, toIdx, usedRestaurantKeys.concat(toIdentityKey));
    const newCost = (dist.get(fromKey) ?? CONFIG.INF_COST) + edge.cost;
    if (newCost < (dist.get(toKey) ?? CONFIG.INF_COST)) {
      dist.set(toKey, newCost);
      arrivalAt.set(toKey, edge.arrival);
      prev.set(toKey, fromKey);
      heap.push({ key: toKey, cost: newCost });
    }
  };

  dist.set(source, 0);
  arrivalAt.set(source, startMinute);
  heap.push({ key: source, cost: 0 });

  while (heap.size > 0) {
    const top = heap.pop();
    if (!top) break;
    const currentCost = dist.get(top.key);
    if (currentCost == null || top.cost !== currentCost) continue;
    if (top.key === sink) break;

    if (top.key === source) {
      const firstMeal = requiredMeals[0];
      const firstSlot = MEAL_SLOTS[firstMeal];
      layers[0].forEach((_, j) => {
        relax(source, originPlace, 0, j, startMinute, firstSlot, []);
      });
      continue;
    }

    const meta = stateMeta.get(top.key);
    if (!meta) continue;
    const { stage, idx, usedRestaurantKeys } = meta;
    const fromPlace = layers[stage][idx];
    const depart = (arrivalAt.get(top.key) ?? MEAL_SLOTS[requiredMeals[stage]].start) + getMealDuration(requiredMeals[stage]);

    if (stage === layers.length - 1) {
      if ((dist.get(top.key) ?? CONFIG.INF_COST) < (dist.get(sink) ?? CONFIG.INF_COST)) {
        dist.set(sink, dist.get(top.key));
        prev.set(sink, top.key);
        heap.push({ key: sink, cost: dist.get(sink) });
      }
      continue;
    }

    const nextStage = stage + 1;
    const nextSlot = MEAL_SLOTS[requiredMeals[nextStage]];
    layers[nextStage].forEach((_, j) => {
      relax(top.key, fromPlace, nextStage, j, depart, nextSlot, usedRestaurantKeys);
    });
  }

  if (!prev.has(sink)) throw new Error("找不到符合時間區間且餐廳不重複的路徑");

  const path = Array(requiredMeals.length).fill(null);
  let cursor = prev.get(sink);
  while (cursor && cursor !== source) {
    const meta = stateMeta.get(cursor);
    if (!meta) break;
    path[meta.stage] = layers[meta.stage][meta.idx];
    cursor = prev.get(cursor);
  }

  if (path.some((x) => !x)) {
    throw new Error("找不到完整且餐廳不重複的路徑");
  }

  return path;
}

function nearbySearchAll(request, maxResults = 60) {
  return new Promise((resolve, reject) => {
    const all = [];

    const callback = (results, status, pagination) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK && status !== google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
        reject(new Error(explainPlacesStatus(status)));
        return;
      }

      if (Array.isArray(results) && results.length > 0) {
        all.push(...results);
      }

      if (pagination && pagination.hasNextPage && all.length < maxResults) {
        setTimeout(() => pagination.nextPage(), 1200);
      } else {
        resolve(all.slice(0, maxResults));
      }
    };

    placesService.nearbySearch(request, callback);
  });
}

function getDetails(placeId) {
  return new Promise((resolve) => {
    placesService.getDetails(
      {
        placeId,
        fields: ["place_id", "name", "rating", "user_ratings_total", "geometry", "types", "opening_hours", "formatted_address", "business_status"]
      },
      (result, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && result) {
          resolve(result);
        } else {
          if (status === google.maps.places.PlacesServiceStatus.REQUEST_DENIED) {
            setStatus(explainPlacesStatus(status));
          }
          resolve(null);
        }
      }
    );
  });
}

async function mapLimit(items, limit, mapper) {
  const out = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      out[idx] = await mapper(items[idx], idx);
    }
  }

  const workers = Array(Math.min(limit, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return out;
}

async function enrichOpenHours(restaurants) {
  // Function 6: 抓取營業時間並把 close - x 分鐘
  const detailed = await mapLimit(restaurants, CONFIG.DETAILS_CONCURRENCY, async (r) => {
    const detail = await getDetails(r.place_id);
    const merged = {
      ...r,
      ...(detail || {})
    };

    const periods = merged.opening_hours && merged.opening_hours.periods ? merged.opening_hours.periods : null;
    merged.openIntervals = getTodayIntervalsFromPeriods(periods, CONFIG.CLOSE_BUFFER_MIN);
    return merged;
  });

  return detailed.filter(Boolean);
}

async function collectRestaurantsInRect(bounds) {
  // Function 1: 蒐集矩形區域內餐廳（含面積限制）
  const areaKm2 = boundsAreaKm2(bounds);
  if (areaKm2 > CONFIG.MAX_RECT_AREA_KM2) {
    throw new Error(`矩形太大 (${areaKm2.toFixed(2)} km²)，上限是 ${CONFIG.MAX_RECT_AREA_KM2} km²`);
  }

  const center = bounds.getCenter();
  const ne = bounds.getNorthEast();
  const radius = Math.ceil(
    google.maps.geometry.spherical.computeDistanceBetween(center, ne)
  );

  const raw = await nearbySearchAll(
    {
      location: center,
      radius: Math.min(radius, CONFIG.MAX_RESTAURANT_RADIUS_M),
      type: "restaurant"
    },
    CONFIG.MAX_RESTAURANT_RESULTS
  );

  const filtered = raw.filter((x) => {
    const loc = x.geometry && x.geometry.location;
    return loc && bounds.contains(loc);
  });

  const uniqueMap = new Map();
  filtered.forEach((r) => {
    if (!r.place_id) return;
    if (!uniqueMap.has(r.place_id)) uniqueMap.set(r.place_id, r);
  });

  const deduped = Array.from(uniqueMap.values());
  const detailed = await enrichOpenHours(deduped);
  const operationalOnly = detailed.filter((r) => isRestaurantOperational(r));
  return sortByWeightDesc(operationalOnly);
}

async function collectAttractionsAroundRestaurant(restaurant, radiusMeters) {
  // Function 9: 餐廳圓半徑內景點
  const loc = restaurant.geometry.location;
  const results = await nearbySearchAll(
    {
      location: loc,
      radius: radiusMeters,
      type: "tourist_attraction"
    },
    CONFIG.MAX_ATTRACTION_RESULTS_PER_RESTAURANT
  );

  const deduped = [];
  const seen = new Set();

  results.forEach((item) => {
    if (!item || !item.place_id) return;
    if (item.place_id === restaurant.place_id) return;
    if (safeArray(item.types).includes("restaurant")) return;
    if (seen.has(item.place_id)) return;
    seen.add(item.place_id);
    deduped.push(item);
  });

  return sortByWeightDesc(deduped);
}

function unionVectors(vecA, vecB) {
  // Function 10: 兩 vector 聯集
  const map = new Map();
  safeArray(vecA).forEach((x) => x.place_id && map.set(x.place_id, x));
  safeArray(vecB).forEach((x) => x.place_id && map.set(x.place_id, x));
  return Array.from(map.values());
}

function buildSegmentVectors(path, perRestaurantAttractions) {
  // Function 11: 四組 vector（相鄰餐廳）
  const vectors = [];
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const vecA = perRestaurantAttractions[a.place_id] || [];
    const vecB = perRestaurantAttractions[b.place_id] || [];
    const merged = unionVectors(vecA, vecB);
    vectors.push(sortByWeightDesc(merged));
  }
  return vectors;
}

function pickTopKRandom(vector, desiredCount = plannerState.randomPickCount) {
  // Function 12: 從前 k_pool 隨機選固定數量
  const pool = safeArray(vector).slice(0, CONFIG.TOP_RANDOM_POOL);
  if (pool.length === 0) return [];

  const maxK = Math.min(pool.length, RANDOM_PICK_LIMITS.max);
  const k = Math.max(RANDOM_PICK_LIMITS.min, Math.min(Math.floor(desiredCount), maxK));
  if (k === 0) return [];
  return shuffle(pool).slice(0, k);
}

function buildInitialSelections(segmentVectors) {
  // Function 13: 依序丟入 func.12
  return segmentVectors.map((vec) => pickTopKRandom(vec, plannerState.randomPickCount));
}

function rerollSelections() {
  if (!plannerState.segmentCandidates.length) return;
  syncRandomPickCountFromControls();
  plannerState.segmentSelections = buildInitialSelections(plannerState.segmentCandidates);
  renderAll();
  setStatus(`已重新抽選候選景點（每段 ${plannerState.randomPickCount} 個）`);
}

function findSegmentCandidate(segIdx, placeId) {
  return safeArray(plannerState.segmentCandidates[segIdx]).find((x) => x.place_id === placeId) || null;
}

function toggleSegmentCandidate(segIdx, placeId, checked) {
  const list = safeArray(plannerState.segmentSelections[segIdx]).slice();
  const existingIdx = list.findIndex((x) => x.place_id === placeId);
  const maxManual = CONFIG.MAX_MANUAL_PICK_PER_SEGMENT || 6;

  if (checked) {
    if (existingIdx >= 0) return;
    if (list.length >= maxManual) {
      setStatus(`每段最多 ${maxManual} 個景點，請先移除再新增`);
      return;
    }
    const candidate = findSegmentCandidate(segIdx, placeId);
    if (!candidate) return;
    list.push(candidate);
  } else if (existingIdx >= 0) {
    list.splice(existingIdx, 1);
  }

  plannerState.segmentSelections[segIdx] = list;
}

function moveSegmentSelection(segIdx, index, dir) {
  const list = safeArray(plannerState.segmentSelections[segIdx]).slice();
  const to = dir === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  plannerState.segmentSelections[segIdx] = list;
}

function buildOrderedStops() {
  const stops = [];
  for (let i = 0; i < plannerState.mealPath.length; i += 1) {
    const mealPlace = plannerState.mealPath[i];
    if (!mealPlace) continue;
    stops.push({
      type: "meal",
      seg: i,
      order: 0,
      place: mealPlace,
      label: `${mealLabel(plannerState.requiredMeals[i])}`
    });
    if (i + 1 < plannerState.mealPath.length) {
      safeArray(plannerState.segmentSelections[i]).forEach((spot, idx) => {
        stops.push({
          type: "spot",
          seg: i,
          order: idx + 1,
          place: spot,
          label: `段 ${i + 1} 景點 ${idx + 1}`
        });
      });
    }
  }
  return stops;
}

function buildDrivingSchedule(stops) {
  const schedule = [];
  if (!Array.isArray(stops) || stops.length === 0) return schedule;

  let currentMinute = plannerState.startMinute;
  let previousPlace = null;
  if (plannerState.center && Number.isFinite(plannerState.center.lat) && Number.isFinite(plannerState.center.lng)) {
    previousPlace = {
      place_id: "__origin__",
      name: "起點",
      geometry: {
        location: new google.maps.LatLng(plannerState.center.lat, plannerState.center.lng)
      }
    };
  }

  stops.forEach((stop) => {
    const driveMinuteRaw = previousPlace ? estimateDrivingMinutes(previousPlace, stop.place) : 0;
    const driveMinute = Number.isFinite(driveMinuteRaw) ? Math.max(0, driveMinuteRaw) : 0;
    let arrivalMinute = currentMinute + driveMinute;

    if (stop.type === "meal") {
      const mealKey = plannerState.requiredMeals[stop.seg];
      const slot = MEAL_SLOTS[mealKey];
      if (slot && arrivalMinute < slot.start) {
        arrivalMinute = slot.start;
      }
    }

    const stayMinute = stop.type === "meal"
      ? mealDurationFor(plannerState.requiredMeals[stop.seg])
      : 0;
    const departMinute = arrivalMinute + stayMinute;

    schedule.push({
      ...stop,
      driveMinute,
      arrivalMinute,
      stayMinute,
      departMinute
    });

    currentMinute = departMinute;
    previousPlace = stop.place;
  });

  return schedule;
}

function mealLabel(mealKey) {
  return MEAL_SLOTS[mealKey] ? MEAL_SLOTS[mealKey].label : mealKey;
}

function renderSegmentVectors() {
  // Function 15: 前端畫出 func.11 的 vectors
  const root = document.getElementById("segment-vectors");
  if (!root) return;

  if (!plannerState.segmentCandidates.length) {
    root.innerHTML = "<div class='empty'>尚未產生景點向量</div>";
    return;
  }

  const html = plannerState.segmentCandidates
    .map((segmentVec, segIdx) => {
      const leftMeal = plannerState.requiredMeals[segIdx];
      const rightMeal = plannerState.requiredMeals[segIdx + 1];
      const selected = safeArray(plannerState.segmentSelections[segIdx]);
      const selectedSet = new Set(selected.map((x) => x.place_id));

      const selectedRows = selected
        .map((item, idx) => {
          const id = item.place_id || "";
          return `
            <div class="spot-row" data-seg="${segIdx}" data-id="${id}">
              <span class="order-badge">${idx + 1}</span>
              <span class="spot-name">${item.name || "(無名稱)"} (${(item.rating || 0).toFixed(1)}★)</span>
              <div class="row-actions">
                <button class="move-btn" data-seg="${segIdx}" data-index="${idx}" data-dir="up">↑</button>
                <button class="move-btn" data-seg="${segIdx}" data-index="${idx}" data-dir="down">↓</button>
                <button class="remove-btn" data-seg="${segIdx}" data-id="${id}">移除</button>
              </div>
            </div>
          `;
        })
        .join("");

      const candidateRows = segmentVec
        .slice(0, CONFIG.MAX_SHOW_CANDIDATES_PER_SEGMENT || 20)
        .map((item, rank) => {
          const id = item.place_id || "";
          const checked = selectedSet.has(id) ? "checked" : "";
          return `
            <label class="cand-row">
              <input type="checkbox" class="cand-toggle" data-seg="${segIdx}" data-id="${id}" ${checked}>
              <span class="cand-rank">#${rank + 1}</span>
              <span>${item.name || "(無名稱)"} (${(item.rating || 0).toFixed(1)}★)</span>
            </label>
          `;
        })
        .join("");

      return `
        <section class="segment-block">
          <h4>${mealLabel(leftMeal)} -> ${mealLabel(rightMeal)}</h4>
          <div class="segment-meta">候選數量: ${segmentVec.length} | 已選順序可上下調整</div>
          <div class="selected-list">${selectedRows || "<div class='empty'>目前無推薦</div>"}</div>
          <details>
            <summary>查看/勾選候選（依排名）</summary>
            <div class="cand-list">${candidateRows || "<div class='empty'>無資料</div>"}</div>
          </details>
        </section>
      `;
    })
    .join("");

  root.innerHTML = html;

  root.querySelectorAll(".cand-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const seg = Number(cb.dataset.seg);
      const id = cb.dataset.id;
      toggleSegmentCandidate(seg, id, cb.checked);
      renderAll();
      setStatus("已更新候選選擇");
    });
  });

  root.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const seg = Number(btn.dataset.seg);
      const id = btn.dataset.id;
      toggleSegmentCandidate(seg, id, false);
      renderAll();
      setStatus("已移除景點");
    });
  });

  root.querySelectorAll(".move-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const seg = Number(btn.dataset.seg);
      const idx = Number(btn.dataset.index);
      const dir = btn.dataset.dir;
      moveSegmentSelection(seg, idx, dir);
      renderAll();
      setStatus("已調整景點順序");
    });
  });
}

function drawRoute() {
  // Function 14: 前端畫最後路徑
  clearOverlays();

  if (!plannerState.mealPath.length) return;

  const stops = buildOrderedStops();
  const routePoints = [];

  stops.forEach((stop, idx) => {
    const loc = placeLoc(stop.place);
    if (!loc) return;

    const marker = new google.maps.Marker({
      map,
      position: loc,
      title: `${stop.label}: ${stop.place.name}`,
      label: `${idx + 1}`
    });
    overlays.markers.push(marker);
    routePoints.push(loc);

    if (stop.type === "spot") {
      marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: "#ff7043",
        fillOpacity: 0.95,
        strokeColor: "#ffffff",
        strokeWeight: 1
      });
    } else {
      const circle = new google.maps.Circle({
        map,
        center: loc,
        radius: CONFIG.DEFAULT_RADIUS,
        fillColor: "#66bb6a",
        fillOpacity: 0.07,
        strokeColor: "#2e7d32",
        strokeOpacity: 0.4,
        strokeWeight: 1
      });
      overlays.circles.push(circle);
    }
  });

  const fit = new google.maps.LatLngBounds();
  routePoints.forEach((p) => fit.extend(p));
  if (!fit.isEmpty()) map.fitBounds(fit);

  if (routePoints.length < 2 || !directionsService || !directionsRenderer) return;

  const token = ++routeDrawToken;
  const origin = routePoints[0];
  const destination = routePoints[routePoints.length - 1];
  const waypoints = routePoints.slice(1, -1).map((p) => ({ location: p, stopover: true }));

  directionsService.route(
    {
      origin,
      destination,
      waypoints,
      optimizeWaypoints: false,
      travelMode: google.maps.TravelMode.DRIVING
    },
    (result, status) => {
      if (token !== routeDrawToken) return;
      if (status === google.maps.DirectionsStatus.OK && result) {
        directionsRenderer.setDirections(result);
      } else {
        setStatus(`開車路徑規劃失敗: ${status}`);
      }
    }
  );
}

function renderSummary() {
  const root = document.getElementById("meal-route");
  if (!root) return;

  if (!plannerState.mealPath.length) {
    root.innerHTML = "<div class='empty'>尚未產生餐廳路徑</div>";
    return;
  }

  root.innerHTML = plannerState.mealPath
    .map((r, i) => {
      const meal = plannerState.requiredMeals[i];
      return `<div class='route-row'>${mealLabel(meal)}: ${r.name} (${(r.rating || 0).toFixed(1)}★)</div>`;
    })
    .join("");
}

function renderEtaSummary() {
  const root = document.getElementById("eta-route");
  if (!root) return;

  if (!plannerState.mealPath.length) {
    plannerState.stopSchedule = [];
    root.innerHTML = "<div class='empty'>尚未產生時間預估</div>";
    return;
  }

  const stops = buildOrderedStops();
  const schedule = buildDrivingSchedule(stops);
  plannerState.stopSchedule = schedule;

  if (schedule.length === 0) {
    root.innerHTML = "<div class='empty'>尚未產生時間預估</div>";
    return;
  }

  root.innerHTML = schedule
    .map((item, idx) => {
      const name = item.place && item.place.name ? item.place.name : "(無名稱)";
      const driveLabel = `車程約 ${Math.round(item.driveMinute)} 分`;
      const etaLabel = `到達 ${minuteToLabel(item.arrivalMinute)}`;
      if (item.type === "meal") {
        return `<div class='route-row'>${idx + 1}. ${item.label}: ${name}｜${driveLabel}｜${etaLabel}｜用餐 ${item.stayMinute} 分</div>`;
      }
      return `<div class='route-row'>${idx + 1}. ${item.label}: ${name}｜${driveLabel}｜${etaLabel}</div>`;
    })
    .join("");
}

function renderAll() {
  renderSummary();
  renderEtaSummary();
  renderSegmentVectors();
  drawRoute();
}

async function collectAttractionsForPath(path) {
  const result = {};
  for (let i = 0; i < path.length; i += 1) {
    const r = path[i];
    // Function 9: 每家店半徑內景點
    result[r.place_id] = await collectAttractionsAroundRestaurant(r, CONFIG.DEFAULT_RADIUS);
  }
  return result;
}

async function generatePlan() {
  syncTimeSettingsFromControls();

  if (!plannerState.bounds) {
    setStatus("請先畫矩形區域");
    return;
  }

  const requiredMeals = getRequiredMeals();
  if (requiredMeals.length === 0) {
    setStatus("請至少勾選一餐");
    return;
  }

  resetPlannerStateKeepBounds();
  plannerState.requiredMeals = requiredMeals;
  clearOverlays();
  setStatus("搜尋餐廳中...");

  try {
    const restaurants = await collectRestaurantsInRect(plannerState.bounds);
    plannerState.restaurants = restaurants;

    if (restaurants.length === 0) {
      setStatus("此區域找不到餐廳");
      return;
    }

    setStatus("分類餐廳中...");
    const mealBuckets = classifyRestaurants(restaurants, requiredMeals);
    plannerState.mealBuckets = mealBuckets;

    const centerLoc = plannerState.center;
    const origin = {
      place_id: "__origin__",
      name: "origin",
      rating: 0,
      geometry: {
        location: new google.maps.LatLng(centerLoc.lat, centerLoc.lng)
      },
      openIntervals: [[0, 24 * 60]]
    };

    setStatus("使用 Dijkstra 計算最優餐廳路徑中...");
    const mealPath = chooseMealPathDijkstra(requiredMeals, mealBuckets, origin, {
      startMinute: plannerState.startMinute,
      mealDurations: plannerState.mealDurations
    });
    plannerState.mealPath = mealPath;

    if (mealPath.length <= 1) {
      plannerState.segmentCandidates = [];
      plannerState.segmentSelections = [];
      renderAll();
      document.getElementById("reroll-btn").disabled = true;
      setStatus("已完成（僅一餐，無景點 segment）");
      return;
    }

    setStatus("抓取餐廳半徑內景點中...");
    plannerState.perRestaurantAttractions = await collectAttractionsForPath(mealPath);

    // Function 11
    plannerState.segmentCandidates = buildSegmentVectors(mealPath, plannerState.perRestaurantAttractions);

    // Function 13
    plannerState.segmentSelections = buildInitialSelections(plannerState.segmentCandidates);

    renderAll();
    document.getElementById("reroll-btn").disabled = false;
    setStatus("路徑完成：可勾選候選、調整順序、再重抽");
  } catch (err) {
    setStatus(`失敗: ${err.message}`);
  }
}

function loadGoogleMaps() {
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_API_KEY}&libraries=drawing,places,geometry&callback=initMap`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

window.initMap = function initMap() {
  if (location.protocol === "file:") {
    setStatus("請改用本機伺服器開啟（例如 python3 -m http.server 8000），不要直接 file:// 開啟。");
  }

  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 25.0339, lng: 121.5644 },
    zoom: 13,
    mapTypeControl: false
  });

  placesService = new google.maps.places.PlacesService(map);
  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    map,
    suppressMarkers: true,
    preserveViewport: true,
    polylineOptions: {
      strokeColor: "#d32f2f",
      strokeOpacity: 0.88,
      strokeWeight: 4
    }
  });

  drawingManager = new google.maps.drawing.DrawingManager({
    drawingMode: google.maps.drawing.OverlayType.RECTANGLE,
    drawingControl: true,
    drawingControlOptions: {
      drawingModes: [google.maps.drawing.OverlayType.RECTANGLE]
    },
    rectangleOptions: {
      fillColor: "#4A90E2",
      fillOpacity: 0.18,
      strokeWeight: 2,
      editable: true,
      draggable: true
    }
  });
  drawingManager.setMap(map);

  google.maps.event.addListener(drawingManager, "rectanglecomplete", (rectangle) => {
    if (selectedRectangle) selectedRectangle.setMap(null);
    selectedRectangle = rectangle;
    drawingManager.setDrawingMode(null);

    const bounds = rectangle.getBounds();
    const center = bounds.getCenter();

    plannerState.bounds = bounds;
    plannerState.center = { lat: center.lat(), lng: center.lng() };

    setStatus("已選擇矩形，請點『產生推薦路徑』");

    rectangle.addListener("bounds_changed", () => {
      plannerState.bounds = rectangle.getBounds();
      const c = plannerState.bounds.getCenter();
      plannerState.center = { lat: c.lat(), lng: c.lng() };
      setStatus("矩形已更新，請重新產生推薦");
    });
  });

  setStatus("請在地圖畫矩形，勾選餐別後按『產生推薦路徑』");
};

function wireControls() {
  const generateBtn = document.getElementById("generate-btn");
  const rerollBtn = document.getElementById("reroll-btn");
  const restartBtn = document.getElementById("restart-btn");
  const startTimeInput = document.getElementById("start-time");
  const ratingInput = document.getElementById("rating-weight");
  const distanceInput = document.getElementById("distance-weight");
  const randomPickInput = document.getElementById("random-pick-count");
  const mealDurationInputs = MEAL_ORDER
    .map((meal) => document.getElementById(`meal-duration-${meal}`))
    .filter(Boolean);

  if (startTimeInput) startTimeInput.value = minuteToTimeInputValue(plannerState.startMinute);
  mealDurationInputs.forEach((input) => {
    input.min = String(MEAL_DURATION_LIMITS.min);
    input.max = String(MEAL_DURATION_LIMITS.max);
    input.step = "5";
    const meal = String(input.id || "").replace("meal-duration-", "");
    input.value = String(mealDurationFor(meal));
  });
  syncTimeSettingsFromControls();

  if (randomPickInput) {
    randomPickInput.min = String(RANDOM_PICK_LIMITS.min);
    randomPickInput.max = String(RANDOM_PICK_LIMITS.max);
    randomPickInput.step = "1";
    randomPickInput.value = String(plannerState.randomPickCount);
  }
  syncRandomPickCountFromControls();

  if (ratingInput) ratingInput.value = String(plannerState.scoringWeights.rating);
  if (distanceInput) distanceInput.value = String(plannerState.scoringWeights.distance);
  syncScoringWeightsFromControls();

  [ratingInput, distanceInput].forEach((input) => {
    if (!input) return;
    input.addEventListener("input", () => {
      syncScoringWeightsFromControls();
    });
    input.addEventListener("change", () => {
      if (plannerState.mealPath.length) {
        setStatus("權重已更新，請重新產生推薦路徑");
      }
    });
  });

  if (randomPickInput) {
    randomPickInput.addEventListener("input", () => {
      syncRandomPickCountFromControls();
    });
    randomPickInput.addEventListener("change", () => {
      if (plannerState.segmentCandidates.length) {
        plannerState.segmentSelections = buildInitialSelections(plannerState.segmentCandidates);
        renderAll();
        setStatus(`已更新每段隨機景點數為 ${plannerState.randomPickCount}`);
      } else if (plannerState.mealPath.length) {
        setStatus("此路徑沒有景點 segment，隨機景點數設定已更新");
      }
    });
  }

  if (startTimeInput) {
    startTimeInput.addEventListener("change", () => {
      syncTimeSettingsFromControls();
      if (plannerState.mealPath.length) {
        renderAll();
        setStatus("開始時間已更新，如要重新挑選餐廳請按『產生推薦路徑』");
      }
    });
  }

  mealDurationInputs.forEach((input) => {
    input.addEventListener("change", () => {
      syncTimeSettingsFromControls();
      if (plannerState.mealPath.length) {
        renderAll();
        setStatus("用餐時間已更新，如要重新挑選餐廳請按『產生推薦路徑』");
      }
    });
  });

  generateBtn.addEventListener("click", async () => {
    syncRandomPickCountFromControls();
    syncScoringWeightsFromControls();
    syncTimeSettingsFromControls();
    await generatePlan();
  });

  rerollBtn.addEventListener("click", () => {
    rerollSelections();
  });

  restartBtn.addEventListener("click", () => {
    location.reload();
  });
}

wireControls();
loadGoogleMaps();

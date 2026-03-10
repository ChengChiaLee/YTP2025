// State
let map;
let drawingManager;
let placesService;
let directionsService;
let directionsRenderer;
let selectedRectangle = null;
let routeDrawToken = 0;

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
  segmentSelections: []
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

function explainDirectionsStatus(status) {
  if (status === google.maps.DirectionsStatus.REQUEST_DENIED) {
    return "Google Directions 被拒絕。請確認：Billing 已啟用、Maps JavaScript API / Directions API / Places API 已啟用、API Key referrer 已允許目前網址。";
  }
  if (status === google.maps.DirectionsStatus.MAX_WAYPOINTS_EXCEEDED) {
    return "途經點太多，請減少候選景點數量後重試。";
  }
  if (status === google.maps.DirectionsStatus.ZERO_RESULTS) {
    return "Google 找不到可步行路線，請調整景點順序或刪除過遠點。";
  }
  if (status === google.maps.DirectionsStatus.OVER_QUERY_LIMIT) {
    return "Google Directions 查詢量超限，請稍後再試。";
  }
  return `Google Directions 失敗: ${status}`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function minuteToLabel(minute) {
  const m = Math.max(0, Math.round(minute));
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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
}

function getRequiredMeals() {
  // Function 2: 決定哪些餐需要
  return MEAL_ORDER.filter((meal) => {
    const cb = document.querySelector(`input[data-meal='${meal}']`);
    return cb ? cb.checked : false;
  });
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

function randomInt(min, max) {
  if (max < min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
    return [[0, 24 * 60]];
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

  if (intervals.length === 0) return [[0, 24 * 60]];

  return intervals
    .map(([s, e]) => [s, Math.max(s, e - bufferMin)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
}

function intersectWindow(intervals, start, end) {
  return safeArray(intervals).some(([s, e]) => Math.max(s, start) < Math.min(e, end));
}

function canArriveAt(place, minute) {
  if (!Array.isArray(place.openIntervals) || place.openIntervals.length === 0) return true;
  return place.openIntervals.some(([s, e]) => minute >= s && minute <= e);
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
    requiredMeals.forEach((meal) => {
      const slot = MEAL_SLOTS[meal];
      if (!slot) return;

      const openFit = intersectWindow(r.openIntervals, slot.start, slot.end);
      if (!openFit) return;

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

  const starPenalty = (5 - placeWeight(v)) * CONFIG.RATING_WEIGHT;
  const travelPenalty = travelMin * CONFIG.TRAVEL_WEIGHT;
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

function chooseMealPathDijkstraCore(requiredMeals, mealBuckets, originPlace) {
  // Function 8: Dijkstra（分層圖）
  if (requiredMeals.length === 0) return [];

  const layers = requiredMeals.map((meal) => {
    const list = safeArray(mealBuckets[meal]);
    if (list.length === 0) throw new Error(`${MEAL_SLOTS[meal].label} 沒有可用餐廳`);
    return list;
  });

  const source = "src";
  const sink = "sink";
  const keyOf = (stage, idx) => `${stage}:${idx}`;

  const dist = new Map();
  const arrivalAt = new Map();
  const prev = new Map();
  const heap = new MinHeap();

  dist.set(source, 0);
  arrivalAt.set(source, MEAL_SLOTS[requiredMeals[0]].start);
  heap.push({ key: source, cost: 0 });

  while (heap.size > 0) {
    const top = heap.pop();
    if (!top) break;
    const currentCost = dist.get(top.key);
    if (currentCost == null || top.cost !== currentCost) continue;
    if (top.key === sink) break;

    const relax = (fromKey, toKey, fromPlace, toPlace, departMinute, slot) => {
      const edge = edgeCost(fromPlace, toPlace, departMinute, slot);
      if (edge.cost >= CONFIG.INF_COST || edge.arrival == null) return;

      const newCost = (dist.get(fromKey) ?? CONFIG.INF_COST) + edge.cost;
      if (newCost < (dist.get(toKey) ?? CONFIG.INF_COST)) {
        dist.set(toKey, newCost);
        arrivalAt.set(toKey, edge.arrival);
        prev.set(toKey, fromKey);
        heap.push({ key: toKey, cost: newCost });
      }
    };

    if (top.key === source) {
      const firstMeal = requiredMeals[0];
      const firstSlot = MEAL_SLOTS[firstMeal];
      layers[0].forEach((cand, j) => {
        relax(source, keyOf(0, j), originPlace, cand, firstSlot.start, firstSlot);
      });
      continue;
    }

    const [stageStr, idxStr] = top.key.split(":");
    const stage = Number(stageStr);
    const idx = Number(idxStr);
    const fromPlace = layers[stage][idx];
    const depart = (arrivalAt.get(top.key) ?? MEAL_SLOTS[requiredMeals[stage]].start) + CONFIG.DINING_DURATION_MIN;

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
    layers[nextStage].forEach((cand, j) => {
      relax(top.key, keyOf(nextStage, j), fromPlace, cand, depart, nextSlot);
    });
  }

  if (!prev.has(sink)) throw new Error("找不到符合時間區間的餐廳路徑");

  const path = Array(requiredMeals.length).fill(null);
  let cursor = prev.get(sink);
  while (cursor && cursor !== source) {
    const [s, j] = cursor.split(":").map(Number);
    path[s] = layers[s][j];
    cursor = prev.get(cursor);
  }
  return path;
}

function chooseMealPathDijkstra(requiredMeals, mealBuckets, originPlace) {
  // 在 Dijkstra 結果上加上「餐廳不可重複」限制
  const workingBuckets = {};
  requiredMeals.forEach((meal) => {
    workingBuckets[meal] = safeArray(mealBuckets[meal]).slice();
  });

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const path = chooseMealPathDijkstraCore(requiredMeals, workingBuckets, originPlace);
    const seen = new Set();
    let dupIndex = -1;
    let dupId = null;

    for (let i = 0; i < path.length; i += 1) {
      const id = path[i] && path[i].place_id ? path[i].place_id : null;
      if (!id) continue;
      if (seen.has(id)) {
        dupIndex = i;
        dupId = id;
        break;
      }
      seen.add(id);
    }

    if (dupIndex < 0) return path;

    const meal = requiredMeals[dupIndex];
    workingBuckets[meal] = safeArray(workingBuckets[meal]).filter((x) => x.place_id !== dupId);
    if (workingBuckets[meal].length === 0) {
      throw new Error(`${MEAL_SLOTS[meal].label} 候選不足，無法避免同店重複`);
    }
  }

  throw new Error("無法在限制次數內找到不重複餐廳路徑");
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
        fields: ["place_id", "name", "rating", "user_ratings_total", "geometry", "types", "opening_hours", "formatted_address"]
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
  return sortByWeightDesc(detailed);
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

function pickTopKRandom(vector) {
  // Function 12: 選前 k，k 為 random
  const pool = safeArray(vector).slice(0, CONFIG.TOP_RANDOM_POOL);
  if (pool.length === 0) return [];

  const maxK = Math.min(CONFIG.MAX_RANDOM_PICK_PER_SEGMENT, pool.length);
  const minK = Math.min(1, maxK);
  const k = randomInt(minK, maxK);
  return shuffle(pool).slice(0, k);
}

function buildInitialSelections(segmentVectors) {
  // Function 13: 依序丟入 func.12
  const used = new Set();
  return segmentVectors.map((vec) => {
    const filtered = safeArray(vec).filter((x) => x.place_id && !used.has(x.place_id));
    const picked = pickTopKRandom(filtered);
    picked.forEach((x) => {
      if (x && x.place_id) used.add(x.place_id);
    });
    return picked;
  });
}

function rerollSelections() {
  if (!plannerState.segmentCandidates.length) return;
  plannerState.segmentSelections = buildInitialSelections(plannerState.segmentCandidates);
  renderAll();
  setStatus("已重新抽選候選景點");
}

function findSegmentCandidate(segIdx, placeId) {
  return safeArray(plannerState.segmentCandidates[segIdx]).find((x) => x.place_id === placeId) || null;
}

function isSpotSelectedInOtherSegments(segIdx, placeId) {
  return plannerState.segmentSelections.some((list, idx) => {
    if (idx === segIdx) return false;
    return safeArray(list).some((x) => x.place_id === placeId);
  });
}

function toggleSegmentCandidate(segIdx, placeId, checked) {
  const list = safeArray(plannerState.segmentSelections[segIdx]).slice();
  const existingIdx = list.findIndex((x) => x.place_id === placeId);
  const maxManual = CONFIG.MAX_MANUAL_PICK_PER_SEGMENT || 6;

  if (checked) {
    if (existingIdx >= 0) return;
    if (isSpotSelectedInOtherSegments(segIdx, placeId)) {
      setStatus("此景點已在其他區段選取，請避免重複");
      return;
    }
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
          const selectedElsewhere = !selectedSet.has(id) && isSpotSelectedInOtherSegments(segIdx, id);
          const disabled = selectedElsewhere ? "disabled" : "";
          const disabledText = selectedElsewhere ? "（已在其他段選取）" : "";
          return `
            <label class="cand-row">
              <input type="checkbox" class="cand-toggle" data-seg="${segIdx}" data-id="${id}" ${checked} ${disabled}>
              <span class="cand-rank">#${rank + 1}</span>
              <span>${item.name || "(無名稱)"} (${(item.rating || 0).toFixed(1)}★) ${disabledText}</span>
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
      travelMode: google.maps.TravelMode.WALKING
    },
    (result, status) => {
      if (token !== routeDrawToken) return;
      if (status === google.maps.DirectionsStatus.OK && result) {
        directionsRenderer.setDirections(result);
      } else {
        setStatus(explainDirectionsStatus(status));
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

function renderAll() {
  renderSummary();
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
    const mealPath = chooseMealPathDijkstra(requiredMeals, mealBuckets, origin);
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

  generateBtn.addEventListener("click", async () => {
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

"""Food Truck Finder — local Flask server.

Fetches SF mobile food vendor data from DataSF's SODA API, caches it in
data/cache.json, and serves it to the frontend. The SODA API is only hit
on first run or when you press "Refresh data" (POST /api/refresh).
"""

import json
import os
import threading
from collections import defaultdict
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_FILE = os.path.join(DATA_DIR, "cache.json")

PERMITS_URL = "https://data.sfgov.org/resource/rqzj-sfat.json"
SCHEDULE_URL = "https://data.sfgov.org/resource/jjew-r69b.json"
PAGE_SIZE = 1000

PORT = 5757

app = Flask(__name__, static_folder="static", static_url_path="")
_refresh_lock = threading.Lock()


def _soda_headers():
    # Optional: set SODA_APP_TOKEN in your environment to raise rate limits.
    token = os.environ.get("SODA_APP_TOKEN")
    return {"X-App-Token": token} if token else {}


def _fetch_all(url):
    """Fetch every row of a SODA dataset, paginating past PAGE_SIZE."""
    rows, offset = [], 0
    while True:
        resp = requests.get(
            url,
            params={"$limit": PAGE_SIZE, "$offset": offset, "$order": ":id"},
            headers=_soda_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def _parse_latlng(row):
    try:
        lat, lng = float(row.get("latitude", 0)), float(row.get("longitude", 0))
    except (TypeError, ValueError):
        return None, None
    # DataSF uses 0,0 for unknown locations; also drop anything far outside SF.
    if not (37.5 < lat < 38.0 and -123.0 < lng < -122.0):
        return None, None
    return lat, lng


def _build_trucks(permits, schedules):
    sched_by_location = defaultdict(list)
    for s in schedules:
        loc_id = s.get("locationid")
        if loc_id:
            sched_by_location[loc_id].append(s)

    trucks = []
    for p in permits:
        lat, lng = _parse_latlng(p)
        entries, seen = [], set()
        for s in sched_by_location.get(p.get("objectid"), []):
            key = (s.get("dayofweekstr"), s.get("start24"), s.get("end24"))
            if key in seen or not s.get("dayofweekstr"):
                continue
            seen.add(key)
            entries.append(
                {
                    "day": s.get("dayofweekstr"),
                    "dayOrder": int(s.get("dayorder", 0)),
                    "start": s.get("starttime", ""),
                    "end": s.get("endtime", ""),
                    "start24": s.get("start24", ""),
                    "end24": s.get("end24", ""),
                }
            )
        entries.sort(key=lambda e: (e["dayOrder"], e["start24"]))

        trucks.append(
            {
                "id": p.get("objectid"),
                "name": p.get("applicant", "Unknown vendor"),
                "facilityType": p.get("facilitytype", ""),
                "address": p.get("address", ""),
                "locationDescription": p.get("locationdescription", ""),
                "food": p.get("fooditems", ""),
                "status": p.get("status", "UNKNOWN"),
                "permit": p.get("permit", ""),
                "approved": (p.get("approved") or "")[:10],
                "expiration": (p.get("expirationdate") or "")[:10],
                "lat": lat,
                "lng": lng,
                "schedule": entries,
            }
        )
    return trucks


def build_cache():
    """Pull both datasets from DataSF and write the merged cache file."""
    permits = _fetch_all(PERMITS_URL)
    schedules = _fetch_all(SCHEDULE_URL)
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trucks": _build_trucks(permits, schedules),
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, CACHE_FILE)
    return payload


def load_cache():
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/trucks")
def api_trucks():
    payload = load_cache()
    if payload is None:
        try:
            payload = build_cache()
        except requests.RequestException as e:
            return jsonify({"error": f"Could not reach DataSF: {e}"}), 502
    return jsonify(payload)


@app.post("/api/refresh")
def api_refresh():
    if not _refresh_lock.acquire(blocking=False):
        return jsonify({"error": "A refresh is already running"}), 409
    try:
        payload = build_cache()
    except requests.RequestException as e:
        # Keep serving the old cache if DataSF is unreachable.
        return jsonify({"error": f"Refresh failed, kept existing cache: {e}"}), 502
    finally:
        _refresh_lock.release()
    return jsonify({"fetched_at": payload["fetched_at"], "count": len(payload["trucks"])})


if __name__ == "__main__":
    print(f"Food Truck Finder → http://localhost:{PORT}")
    if load_cache() is None:
        print("No local cache yet — the first page load will fetch from DataSF.")
    app.run(port=PORT, debug=False)

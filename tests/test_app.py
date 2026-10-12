import json

import pytest
import requests

import app


def permit(objectid, **fields):
    row = {
        "objectid": objectid,
        "applicant": f"Vendor {objectid}",
        "status": "APPROVED",
        "latitude": "37.7765",
        "longitude": "-122.4172",
    }
    row.update(fields)
    return row


def slot(locationid, day, start24, end24, dayorder):
    return {
        "locationid": locationid,
        "dayofweekstr": day,
        "dayorder": str(dayorder),
        "starttime": start24,
        "endtime": end24,
        "start24": start24,
        "end24": end24,
    }


@pytest.mark.parametrize(
    "lat, lng, expected",
    [
        ("37.7765", "-122.4172", (37.7765, -122.4172)),
        ("0", "0", (None, None)),  # DataSF's placeholder for "no location"
        ("37.7765", "-121.5", (None, None)),  # outside the SF box
        ("", "", (None, None)),
        (None, None, (None, None)),
    ],
)
def test_parse_latlng(lat, lng, expected):
    assert app._parse_latlng({"latitude": lat, "longitude": lng}) == expected


def test_parse_latlng_missing_fields():
    assert app._parse_latlng({}) == (None, None)


def test_schedule_joins_on_locationid_to_objectid():
    permits = [permit("10"), permit("11")]
    # The schedule's own objectid is unrelated; only locationid points at a permit.
    schedules = [dict(slot("10", "Monday", "07:00", "10:00", 1), objectid="11")]

    trucks = {t["id"]: t for t in app._build_trucks(permits, schedules)}

    assert [s["day"] for s in trucks["10"]["schedule"]] == ["Monday"]
    assert trucks["11"]["schedule"] == []


def test_schedule_is_deduplicated_and_sorted():
    schedules = [
        slot("10", "Friday", "11:00", "14:00", 5),
        slot("10", "Monday", "16:00", "20:00", 1),
        slot("10", "Monday", "07:00", "10:00", 1),
        slot("10", "Monday", "07:00", "10:00", 1),
        slot("10", "", "07:00", "10:00", 0),
    ]

    (truck,) = app._build_trucks([permit("10")], schedules)

    assert [(s["day"], s["start24"]) for s in truck["schedule"]] == [
        ("Monday", "07:00"),
        ("Monday", "16:00"),
        ("Friday", "11:00"),
    ]


def test_trucks_without_coordinates_or_schedule_are_kept():
    (truck,) = app._build_trucks([permit("10", latitude="0", longitude="0")], [])

    assert truck["lat"] is None and truck["lng"] is None
    assert truck["schedule"] == []


def test_bad_dayorder_does_not_break_the_build():
    (truck,) = app._build_trucks([permit("10")], [slot("10", "Monday", "07:00", "10:00", "x")])

    assert truck["schedule"][0]["dayOrder"] == 0


def test_dates_are_trimmed_to_iso_day():
    (truck,) = app._build_trucks(
        [permit("10", approved="2026-01-15T00:00:00.000", expirationdate="2027-01-15T00:00:00.000")], []
    )

    assert (truck["approved"], truck["expiration"]) == ("2026-01-15", "2027-01-15")


def test_fetch_all_pages_until_a_short_page(monkeypatch):
    monkeypatch.setattr(app, "PAGE_SIZE", 2)
    offsets = []

    class Response:
        def __init__(self, rows):
            self.rows = rows

        def raise_for_status(self):
            pass

        def json(self):
            return self.rows

    def fake_get(url, params, headers, timeout):
        offsets.append(params["$offset"])
        return Response([{}] * (2 if params["$offset"] < 4 else 1))

    monkeypatch.setattr(app.requests, "get", fake_get)

    assert len(app._fetch_all("https://example.invalid")) == 5
    assert offsets == [0, 2, 4]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(app, "CACHE_FILE", str(tmp_path / "cache.json"))
    return app.app.test_client()


def unreachable(url):
    raise requests.ConnectionError("network is down")


def test_trucks_endpoint_builds_and_caches_on_first_load(client, monkeypatch):
    rows = {app.PERMITS_URL: [permit("10")], app.SCHEDULE_URL: [slot("10", "Monday", "07:00", "10:00", 1)]}
    monkeypatch.setattr(app, "_fetch_all", rows.__getitem__)

    body = client.get("/api/trucks").get_json()

    assert [t["id"] for t in body["trucks"]] == ["10"]
    assert app.load_cache() == body


def test_trucks_endpoint_reports_unreachable_datasf(client, monkeypatch):
    monkeypatch.setattr(app, "_fetch_all", unreachable)

    res = client.get("/api/trucks")

    assert res.status_code == 502
    assert res.get_json()["error"] == "Could not reach DataSF (ConnectionError)."


def test_failed_refresh_keeps_existing_cache(client, monkeypatch):
    cached = {"fetched_at": "2026-01-01T00:00:00+00:00", "trucks": [{"id": "10"}]}
    with open(app.CACHE_FILE, "w") as f:
        json.dump(cached, f)
    monkeypatch.setattr(app, "_fetch_all", unreachable)

    assert client.post("/api/refresh").status_code == 502
    assert client.get("/api/trucks").get_json() == cached


def test_config_serves_a_public_mapbox_token(client, monkeypatch):
    monkeypatch.setenv("MAPBOX_TOKEN", "pk.abc")

    assert client.get("/api/config").get_json() == {"mapboxToken": "pk.abc"}


@pytest.mark.parametrize("token", ["", "sk.secret"])
def test_config_withholds_missing_or_secret_tokens(client, monkeypatch, token):
    monkeypatch.setenv("MAPBOX_TOKEN", token)

    assert client.get("/api/config").get_json() == {"mapboxToken": ""}


def test_load_dotenv_does_not_override_the_environment(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nMAPBOX_TOKEN='pk.from-file'\nSODA_APP_TOKEN=from-file\nnot a pair\n")
    monkeypatch.delenv("MAPBOX_TOKEN", raising=False)
    monkeypatch.setenv("SODA_APP_TOKEN", "from-shell")

    app.load_dotenv(str(env))

    assert app.os.environ["MAPBOX_TOKEN"] == "pk.from-file"
    assert app.os.environ["SODA_APP_TOKEN"] == "from-shell"


def test_load_dotenv_ignores_a_missing_file(tmp_path):
    app.load_dotenv(str(tmp_path / "missing.env"))

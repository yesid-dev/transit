"""Decoded STM alert occurrences, without storage or caller activation."""

from google.transit import gtfs_realtime_pb2

from transit_ops.providers.alert_record import AlertIdentityInputs, AlertRecord, InformedEntity
from transit_ops.silver.i3 import (
    _active_periods,
    _entity_value,
    _informed_entities,
    _payload_alerts,
    _text,
    _timestamp,
    _translated_texts,
    _value,
)


def stm_json_alerts(payload: object) -> tuple[AlertRecord, ...]:
    return tuple(
        _record(raw, index)
        for index, raw in enumerate(_payload_alerts(payload))
        if isinstance(raw, dict)
    )


def _record(raw: dict[str, object], index: int) -> AlertRecord:
    periods = tuple(_active_periods(raw))
    header = _value(raw, "header", "title", "summary", "header_texts")
    description = _value(raw, "description", "body", "message", "description_texts")
    alert_id = _text(_value(raw, "id", "alertId", "messageId"))
    cause, effect = _text(raw.get("cause")), _text(raw.get("effect"))
    severity = _text(_value(raw, "severity", "priority"))
    published = _timestamp(_value(raw, "publishedAt", "published_at"))
    updated = _timestamp(_value(raw, "updatedAt", "updated_at"))
    selectors = tuple(
        InformedEntity(
            None,
            _entity_value(s, "routeId", "route_id", "route", "route_short_name"),
            None,
            _entity_value(s, "stopId", "stop_id", "stop", "stop_code"),
            _entity_value(s, "areaId", "area_id", "area"),
            _entity_value(s, "tripId", "trip_id", "trip"),
            s,
        )
        for s in _informed_entities(raw)
    )
    identity = AlertIdentityInputs(
        alert_id,
        _text(header),
        _text(description),
        severity,
        cause,
        effect,
        *(periods[0] if periods else (None, None)),
        published,
        updated,
        periods[1:],
    )
    return AlertRecord(
        index,
        alert_id,
        _translated_texts(header),
        _translated_texts(description),
        _translated_texts(_value(raw, "url", "link")),
        cause,
        effect,
        severity,
        cause if cause in gtfs_realtime_pb2.Alert.Cause.keys() else None,
        effect if effect in gtfs_realtime_pb2.Alert.Effect.keys() else None,
        periods,
        selectors,
        published,
        updated,
        identity,
        raw,
    )

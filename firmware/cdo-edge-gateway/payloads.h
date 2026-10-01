/*
 * The wire payloads this board publishes, as plain string builders.
 *
 * Everything here is snprintf, not ArduinoJson. Telemetry and spectrum run at
 * 2 Hz around the clock, and snprintf does not touch the heap. Printing through
 * "%.Nf" also keeps numbers exactly as long as the channel's decimals say:
 * ArduinoJson prints a float with up to six decimals, so 40.2f could appear on the
 * wire as 40.200001.
 *
 * Every builder returns the number of bytes written, or -1 when the result did
 * not fit. A truncated JSON message is worse than none: the receiver would drop
 * it, and the board would never know. Callers treat -1 as a failed publish.
 *
 * The strings printed verbatim (firmware version, boot id, reset reason,
 * scenario name, channel key) all come from a fixed, safe alphabet, so none needs
 * JSON escaping. Text that might carry anything else goes through
 * sanitizeInto() first.
 *
 * Arduino-free on purpose: <stdio.h> only.
 */

#pragma once

#include <inttypes.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "catalog.h"

namespace cdo {

/* A bounded, append-only string writer. Once anything does not fit, `ok` stays
 * false and later appends do nothing. */
class Out {
 public:
  Out(char* buffer, size_t capacity) : buffer_(buffer), capacity_(capacity) {
    if (capacity_ > 0) buffer_[0] = '\0';
  }

  void print(const char* format, ...) __attribute__((format(printf, 2, 3))) {
    if (!ok_) return;
    va_list args;
    va_start(args, format);
    const int n = vsnprintf(buffer_ + length_, capacity_ - length_, format, args);
    va_end(args);
    if (n < 0 || static_cast<size_t>(n) >= capacity_ - length_) {
      ok_ = false;
      return;
    }
    length_ += static_cast<size_t>(n);
  }

  /* Bytes written, or -1 if anything was truncated. */
  int result() const { return ok_ ? static_cast<int>(length_) : -1; }

 private:
  char* buffer_;
  size_t capacity_;
  size_t length_ = 0;
  bool ok_ = true;
};

/* Copy `source` into `destination`, keeping only characters that are safe to
 * embed in a JSON string without escaping. Anything else becomes '?'. Always
 * terminates. */
inline void sanitizeInto(char* destination, size_t capacity, const char* source) {
  if (capacity == 0) return;
  size_t i = 0;
  for (; source != nullptr && source[i] != '\0' && i + 1 < capacity; ++i) {
    const char c = source[i];
    const bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                      c == '_' || c == '-' || c == '.' || c == ' ' || c == ':' || c == '/';
    destination[i] = safe ? c : '?';
  }
  destination[i] = '\0';
}

/* {"v":1,"seq":N,"ts":N,"synced":B,"m":{"KEY":1.23,...}} */
inline int formatTelemetry(char* buffer, size_t capacity, uint32_t seq, uint64_t tsMs, bool synced,
                           const CdoChannel* channels, int count, const double* values) {
  Out out(buffer, capacity);
  out.print("{\"v\":1,\"seq\":%" PRIu32 ",\"ts\":%" PRIu64 ",\"synced\":%s,\"m\":{", seq, tsMs,
            synced ? "true" : "false");
  for (int i = 0; i < count; ++i) {
    out.print("%s\"%s\":%.*f", i == 0 ? "" : ",", channels[i].key, static_cast<int>(channels[i].decimals),
              values[i]);
  }
  out.print("}}");
  return out.result();
}

/* {"v":1,"seq":N,"ts":N,"key":"...","amp":[0.031,...]} */
inline int formatSpectrum(char* buffer, size_t capacity, uint32_t seq, uint64_t tsMs, const char* key,
                          const double* bins, int count) {
  Out out(buffer, capacity);
  out.print("{\"v\":1,\"seq\":%" PRIu32 ",\"ts\":%" PRIu64 ",\"key\":\"%s\",\"amp\":[", seq, tsMs, key);
  for (int i = 0; i < count; ++i) out.print("%s%.3f", i == 0 ? "" : ",", bins[i]);
  out.print("]}");
  return out.result();
}

/* What `diag` reports. Strings must come from a safe alphabet (see the header). */
struct DiagInfo {
  uint64_t tsMs;
  const char* fw;
  const char* bootId;
  uint32_t uptimeS;
  int rssi;
  uint32_t heapFree;
  uint32_t heapMin;
  const char* reset;
  uint32_t wifiReconnects;
  uint32_t mqttReconnects;
  uint32_t restarts;
  uint32_t publishFailures;
  bool tls;
  bool insecure;
  const char* scenario;
  double ramp;
  double rampSec;
};

inline int formatDiag(char* buffer, size_t capacity, const DiagInfo& d) {
  Out out(buffer, capacity);
  out.print("{\"v\":1,\"ts\":%" PRIu64 ",\"fw\":\"%s\",\"bootId\":\"%s\",\"uptimeS\":%" PRIu32
            ",\"rssi\":%d,\"heapFree\":%" PRIu32 ",\"heapMin\":%" PRIu32 ",\"reset\":\"%s\"",
            d.tsMs, d.fw, d.bootId, d.uptimeS, d.rssi, d.heapFree, d.heapMin, d.reset);
  out.print(",\"wifiReconnects\":%" PRIu32 ",\"mqttReconnects\":%" PRIu32 ",\"restarts\":%" PRIu32
            ",\"publishFailures\":%" PRIu32 ",\"tls\":%s,\"insecure\":%s",
            d.wifiReconnects, d.mqttReconnects, d.restarts, d.publishFailures, d.tls ? "true" : "false",
            d.insecure ? "true" : "false");
  out.print(",\"sim\":{\"scenario\":\"%s\",\"ramp\":%.3f,\"rampSec\":%g}}", d.scenario, d.ramp, d.rampSec);
  return out.result();
}

/* {"cmdId":"...","name":"...","ok":B,"detail":"...","ts":N}. `detail` is sanitised
 * and cut to 160 characters, the backend's limit. */
inline int formatAck(char* buffer, size_t capacity, const char* cmdId, const char* name, bool ok,
                     const char* detail, uint64_t tsMs) {
  char safe[161];
  sanitizeInto(safe, sizeof safe, detail);
  Out out(buffer, capacity);
  out.print("{\"cmdId\":\"%s\",\"name\":\"%s\",\"ok\":%s,\"detail\":\"%s\",\"ts\":%" PRIu64 "}", cmdId, name,
            ok ? "true" : "false", safe, tsMs);
  return out.result();
}

/* True if `id` is a command id the backend will accept back in an ack:
 * 1 to 32 characters from [A-Za-z0-9-]. Checked before echoing it. */
inline bool isValidCommandId(const char* id) {
  if (id == nullptr) return false;
  const size_t length = strlen(id);
  if (length < 1 || length > 32) return false;
  for (size_t i = 0; i < length; ++i) {
    const char c = id[i];
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
    if (!ok) return false;
  }
  return true;
}

}  // namespace cdo

/*
 * Types the sketch's functions take as parameters.
 *
 * They live in a header on purpose. The Arduino build inserts a prototype for
 * every function in the .ino near the top of the file, before any type the .ino
 * itself defines, so a function whose signature names a sketch-local type fails
 * to compile. Types declared in a header are already known at that point.
 */

#pragma once

#include <stdint.h>

#include "config.h"

/* The connection state machine. */
enum class State : uint8_t { WifiConnect, TimeSync, MqttConnect, Running, Backoff };

/* A command received on cmd/<name>, waiting for the loop to handle it. */
struct PendingCommand {
  char name[CDO_CMD_NAME_MAX];
  uint16_t length;
  char payload[CDO_CMD_PAYLOAD_MAX];
};

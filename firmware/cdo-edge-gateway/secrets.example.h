/*
 * Wi-Fi and broker credentials. COPY THIS FILE to secrets.h and fill it in.
 *
 *     cp firmware/cdo-edge-gateway/secrets.example.h firmware/cdo-edge-gateway/secrets.h
 *
 * secrets.h is gitignored and must never be committed. Only this template is.
 *
 * Every value that starts with CHANGE_ME has to be replaced. scripts/fw.mjs
 * refuses to upload while one remains, so a half-filled file cannot be flashed.
 */

#pragma once

/* ---- Wi-Fi -----------------------------------------------------------------
 * Up to three networks; the strongest one that is in range is used. An ESP32
 * is 2.4 GHz only: it cannot join a 5 GHz-only network. Leave a pair as ""
 * to skip it. A phone hotspot is a good second entry for a demo away from home.
 */
#define WIFI_SSID_1 "CHANGE_ME_2g4_network_name"
#define WIFI_PASS_1 "CHANGE_ME_network_password"
#define WIFI_SSID_2 ""
#define WIFI_PASS_2 ""
#define WIFI_SSID_3 ""
#define WIFI_PASS_3 ""

/* ---- Broker ----------------------------------------------------------------
 * HiveMQ Cloud: the cluster hostname, never an IP address. TLS needs the name
 * (SNI) to pick the right certificate.
 *
 * Plan B, a broker on your own network (see firmware/README.md):
 *     #define MQTT_HOST "192.168.1.50"
 *     #define MQTT_PORT 1883
 *     #define CDO_TLS   0
 * and leave the user and password empty if the broker allows anonymous access.
 */
#define MQTT_HOST "CHANGE_ME_cluster-id.s1.eu.hivemq.cloud"
#define MQTT_PORT 8883
#define CDO_TLS 1

/* Must match MQTT_SITE_ID on the server. Lower case letters, digits and hyphens. */
#define SITE_ID "vit-lab"

/* ---- Credentials ------------------------------------------------------------
 * One per machine. The HiveMQ free plan ties one topic permission to each
 * credential, so each machine gets publish and subscribe on
 * cdo/v1/vit-lab/<machineId>/# only. Both lists live here so a single
 * secrets.h serves both boards: the build picks the pair for MACHINE_TYPE.
 */
#define MQTT_USER_ROBOT "CHANGE_ME_robot_user"
#define MQTT_PASS_ROBOT "CHANGE_ME_robot_password"
#define MQTT_USER_PRESS "CHANGE_ME_press_user"
#define MQTT_PASS_PRESS "CHANGE_ME_press_password"

/* ---- Optional ---------------------------------------------------------------
 * Over-the-air updates (experimental, off by default). See firmware/README.md.
 *     #define CDO_OTA 1
 *     #define OTA_PASSWORD "CHANGE_ME_ota_password"
 *
 * Accept an unverified TLS connection if the clock cannot be set (a network that
 * blocks UDP 123). This defeats certificate checking. Leave it off unless you
 * are debugging, and note that `diag.insecure` reports when it was used.
 *     #define CDO_ALLOW_INSECURE_FALLBACK 1
 */

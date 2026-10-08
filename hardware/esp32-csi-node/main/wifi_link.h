/*
 * Station-mode WiFi link.
 *
 * Two behaviours worth knowing about:
 *
 *  - **Power save is disabled.** The default modem sleep parks the radio between
 *    beacons, which destroys any hope of an evenly sampled CSI series. This is
 *    the single most common reason a node "works" but produces unusable data.
 *  - **Reconnection is unconditional and quiet.** A node is unattended, on a
 *    charger, in a room nobody is in; it must come back from an AP reboot without
 *    anyone power-cycling it, and without filling the log.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Bring up the station interface and start connecting. Non-blocking. */
bool wifi_link_start(const char *ssid, const char *password);

/* True once the interface has an IP address. */
bool wifi_link_is_up(void);

/* Current AP RSSI in dBm, or 0 if unknown. */
int8_t wifi_link_rssi(void);

/* Current channel, or 0 if unknown. */
uint8_t wifi_link_channel(void);

/* Dotted-quad address of this node, or "0.0.0.0". */
const char *wifi_link_ip(void);

/* Count of disconnect events since boot — a link-quality signal in its own right. */
uint32_t wifi_link_disconnects(void);

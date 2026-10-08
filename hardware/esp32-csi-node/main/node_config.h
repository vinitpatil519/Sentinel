/*
 * Node configuration, persisted in NVS.
 *
 * Deliberately *not* compiled in. Three boards are flashed with one binary and
 * then told apart by what is in NVS — so a re-flash does not require editing
 * source per node, and a node id can never silently collide because someone
 * rebuilt with the wrong constant. Provisioning is over the serial console
 * (`tools/provision.py`, or by hand with `idf.py monitor`).
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#define NODE_SSID_MAX 33
#define NODE_PASS_MAX 65
#define NODE_IP_MAX 46

typedef struct {
    char ssid[NODE_SSID_MAX];
    char password[NODE_PASS_MAX];
    char target_ip[NODE_IP_MAX];  /* host running the sensing server */
    uint16_t target_port;         /* UDP; 5005 is what the server binds */
    uint8_t node_id;              /* 1..255, unique per deployment */
    uint16_t report_hz;           /* frames published per second */
    uint16_t poke_hz;             /* traffic-generation rate (see csi_capture.h) */
    bool configured;              /* false until a provisioning save succeeds */
} node_config_t;

/* Load from NVS, falling back to defaults (and configured = false). */
void node_config_load(node_config_t *cfg);

/* Persist to NVS. Returns false if the write failed. */
bool node_config_save(const node_config_t *cfg);

/* Erase the stored configuration. */
bool node_config_clear(void);

/* Print the current configuration to the console; the password is masked. */
void node_config_print(const node_config_t *cfg);

/*
 * Handle one provisioning command line. Returns true if the line was a
 * recognised command. Commands:
 *   show
 *   set ssid <value> | pass <value> | ip <value> | port <n> | id <n>
 *       | report_hz <n> | poke_hz <n>
 *   save
 *   clear
 *   reboot
 */
bool node_config_command(node_config_t *cfg, const char *line);

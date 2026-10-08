#include "node_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_system.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "cfg";
static const char *NVS_NAMESPACE = "sentinel";

#define DEFAULT_PORT 5005
#define DEFAULT_REPORT_HZ 10
#define DEFAULT_POKE_HZ 100

static void set_defaults(node_config_t *cfg)
{
    memset(cfg, 0, sizeof(*cfg));
    cfg->target_port = DEFAULT_PORT;
    cfg->node_id = 1;
    cfg->report_hz = DEFAULT_REPORT_HZ;
    cfg->poke_hz = DEFAULT_POKE_HZ;
    cfg->configured = false;
}

static void get_str(nvs_handle_t h, const char *key, char *out, size_t out_len)
{
    size_t len = out_len;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) {
        out[0] = '\0';
    }
}

void node_config_load(node_config_t *cfg)
{
    set_defaults(cfg);

    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGW(TAG, "no stored configuration — node is unprovisioned");
        return;
    }

    get_str(h, "ssid", cfg->ssid, sizeof(cfg->ssid));
    get_str(h, "pass", cfg->password, sizeof(cfg->password));
    get_str(h, "ip", cfg->target_ip, sizeof(cfg->target_ip));

    uint16_t u16 = 0;
    uint8_t u8 = 0;
    if (nvs_get_u16(h, "port", &u16) == ESP_OK && u16 != 0) cfg->target_port = u16;
    if (nvs_get_u8(h, "id", &u8) == ESP_OK && u8 != 0) cfg->node_id = u8;
    if (nvs_get_u16(h, "rhz", &u16) == ESP_OK && u16 != 0) cfg->report_hz = u16;
    if (nvs_get_u16(h, "phz", &u16) == ESP_OK && u16 != 0) cfg->poke_hz = u16;
    nvs_close(h);

    cfg->configured = cfg->ssid[0] != '\0' && cfg->target_ip[0] != '\0';
}

bool node_config_save(const node_config_t *cfg)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed");
        return false;
    }
    esp_err_t err = ESP_OK;
    err |= nvs_set_str(h, "ssid", cfg->ssid);
    err |= nvs_set_str(h, "pass", cfg->password);
    err |= nvs_set_str(h, "ip", cfg->target_ip);
    err |= nvs_set_u16(h, "port", cfg->target_port);
    err |= nvs_set_u8(h, "id", cfg->node_id);
    err |= nvs_set_u16(h, "rhz", cfg->report_hz);
    err |= nvs_set_u16(h, "phz", cfg->poke_hz);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "save failed");
        return false;
    }
    return true;
}

bool node_config_clear(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_erase_all(h);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err == ESP_OK;
}

void node_config_print(const node_config_t *cfg)
{
    printf("\n--- node configuration ---\n");
    printf("  node_id    %u\n", (unsigned)cfg->node_id);
    printf("  ssid       %s\n", cfg->ssid[0] ? cfg->ssid : "(unset)");
    printf("  password   %s\n", cfg->password[0] ? "(set)" : "(unset)");
    printf("  target     %s:%u\n", cfg->target_ip[0] ? cfg->target_ip : "(unset)",
           (unsigned)cfg->target_port);
    printf("  report_hz  %u\n", (unsigned)cfg->report_hz);
    printf("  poke_hz    %u\n", (unsigned)cfg->poke_hz);
    printf("  state      %s\n", cfg->configured ? "provisioned" : "UNPROVISIONED");
    printf("--------------------------\n\n");
}

/* Copy a token into a fixed buffer, refusing rather than truncating: a silently
 * cut SSID or IP produces a node that looks provisioned and never connects. */
static bool copy_token(char *dst, size_t dst_len, const char *src, const char *what)
{
    size_t n = strlen(src);
    if (n == 0 || n >= dst_len) {
        printf("ERR %s must be 1..%u characters\n", what, (unsigned)(dst_len - 1));
        return false;
    }
    memcpy(dst, src, n + 1);
    return true;
}

bool node_config_command(node_config_t *cfg, const char *line)
{
    char buf[160];
    strncpy(buf, line, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char *verb = strtok(buf, " \t\r\n");
    if (verb == NULL) {
        return false;
    }

    if (strcmp(verb, "show") == 0) {
        node_config_print(cfg);
        return true;
    }
    if (strcmp(verb, "save") == 0) {
        cfg->configured = cfg->ssid[0] != '\0' && cfg->target_ip[0] != '\0';
        if (!cfg->configured) {
            printf("ERR need at least ssid and ip before save\n");
            return true;
        }
        printf(node_config_save(cfg) ? "OK saved\n" : "ERR save failed\n");
        return true;
    }
    if (strcmp(verb, "clear") == 0) {
        printf(node_config_clear() ? "OK cleared\n" : "ERR clear failed\n");
        return true;
    }
    if (strcmp(verb, "reboot") == 0) {
        printf("OK rebooting\n");
        fflush(stdout);
        esp_restart();
        return true;
    }
    if (strcmp(verb, "set") != 0) {
        return false;
    }

    char *key = strtok(NULL, " \t\r\n");
    char *value = strtok(NULL, "\r\n");
    if (key == NULL || value == NULL) {
        printf("ERR usage: set <ssid|pass|ip|port|id|report_hz|poke_hz> <value>\n");
        return true;
    }
    while (*value == ' ' || *value == '\t') {
        value++;
    }

    if (strcmp(key, "ssid") == 0) {
        if (copy_token(cfg->ssid, sizeof(cfg->ssid), value, "ssid")) printf("OK ssid\n");
    } else if (strcmp(key, "pass") == 0) {
        if (copy_token(cfg->password, sizeof(cfg->password), value, "pass")) printf("OK pass\n");
    } else if (strcmp(key, "ip") == 0) {
        if (copy_token(cfg->target_ip, sizeof(cfg->target_ip), value, "ip")) printf("OK ip\n");
    } else if (strcmp(key, "port") == 0) {
        int v = atoi(value);
        if (v <= 0 || v > 65535) {
            printf("ERR port 1..65535\n");
        } else {
            cfg->target_port = (uint16_t)v;
            printf("OK port\n");
        }
    } else if (strcmp(key, "id") == 0) {
        int v = atoi(value);
        if (v < 1 || v > 255) {
            printf("ERR id 1..255\n");
        } else {
            cfg->node_id = (uint8_t)v;
            printf("OK id\n");
        }
    } else if (strcmp(key, "report_hz") == 0) {
        int v = atoi(value);
        /* 50 Hz is well past what the analysis uses (the respiration band tops
         * out at 0.5 Hz) and only wastes airtime. */
        if (v < 1 || v > 50) {
            printf("ERR report_hz 1..50\n");
        } else {
            cfg->report_hz = (uint16_t)v;
            printf("OK report_hz\n");
        }
    } else if (strcmp(key, "poke_hz") == 0) {
        int v = atoi(value);
        if (v < 10 || v > 400) {
            printf("ERR poke_hz 10..400\n");
        } else {
            cfg->poke_hz = (uint16_t)v;
            printf("OK poke_hz\n");
        }
    } else {
        printf("ERR unknown key %s\n", key);
    }
    return true;
}

/**
 *  Picture Frame (Hubitat device driver)
 *
 *  Controls the picture-frame server (https://github.com/rajeevhans/picture-frame)
 *  and the TV it's connected to, over the frame's HTTP API.
 *
 *  - Switch on/off      -> TV power (POST /api/tv/on|off)
 *  - Media transport    -> slideshow play/pause (POST /api/slideshow/start|pause)
 *  - Next/previous, shuffle, favorite, delete, favorites-only, mode, order, interval
 *  - Live updates from the frame's Server-Sent Events stream (/api/events),
 *    so photo/favorite/play-state attributes change the moment the frame does
 *  - Buttons 1-7 for Pico remotes and dashboards (see BUTTONS below)
 *
 *  Install: Drivers Code -> New Driver -> paste -> Save. Then Devices ->
 *  Add Device -> Virtual -> Type "Picture Frame", set the frame's IP, Save.
 */

import groovy.transform.Field

@Field static final List BUTTONS = [
    [1, 'Next photo'],
    [2, 'Previous photo'],
    [3, 'Play/pause slideshow'],
    [4, 'Toggle favorite on current photo'],
    [5, 'Toggle favorites-only'],
    [6, 'Toggle TV power'],
    [7, 'Shuffle into a new order']
]
@Field static final List INTERVALS = ['5', '10', '15', '30', '60', '300']
@Field static final List MODES = ['sequential', 'random', 'smart', 'artistic']
@Field static final List ORDERS = ['date', 'filename', 'thisday']
@Field static final List TV_KEYS = [
    'KEY_POWER', 'KEY_SOURCE', 'KEY_HDMI', 'KEY_HDMI1', 'KEY_HDMI2', 'KEY_HDMI3', 'KEY_HDMI4',
    'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER',
    'KEY_RETURN', 'KEY_HOME', 'KEY_MENU', 'KEY_EXIT', 'KEY_INFO', 'KEY_TOOLS', 'KEY_GUIDE',
    'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE',
    'KEY_CHUP', 'KEY_CHDOWN', 'KEY_PRECH', 'KEY_CH_LIST',
    'KEY_REWIND', 'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_FF',
    'KEY_0', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5', 'KEY_6', 'KEY_7', 'KEY_8', 'KEY_9'
]

metadata {
    definition(name: 'Picture Frame', namespace: 'pictureframe', author: 'rhans',
               importUrl: 'https://raw.githubusercontent.com/rajeevhans/picture-frame/main/hubitat/picture-frame-driver.groovy') {
        capability 'Actuator'
        capability 'Sensor'
        capability 'Switch'            // TV power
        capability 'MediaTransport'    // slideshow play/pause
        capability 'PushableButton'
        capability 'Refresh'
        capability 'Initialize'

        attribute 'tvPower', 'string'          // on | standby | unreachable | unknown
        attribute 'photoId', 'number'
        attribute 'photoName', 'string'
        attribute 'photoDate', 'string'
        attribute 'photoLocation', 'string'
        attribute 'photoFavorite', 'enum', ['true', 'false']
        attribute 'photoUrl', 'string'
        attribute 'photoTile', 'string'        // HTML <img> for dashboard attribute tiles
        attribute 'favoritesOnly', 'enum', ['on', 'off']
        attribute 'shuffle', 'enum', ['on', 'off']
        attribute 'slideshowMode', 'string'
        attribute 'slideshowOrder', 'string'
        attribute 'slideInterval', 'number'
        attribute 'eventStream', 'enum', ['connected', 'disconnected']

        command 'nextPhoto'
        command 'previousPhoto'
        command 'togglePlayPause'
        command 'shuffle'
        command 'unshuffle'
        command 'toggleFavorite'
        command 'deletePhoto'
        command 'showFavorites'
        command 'showAllPhotos'
        command 'toggleFavoritesOnly'
        command 'setSlideInterval', [[name: 'Seconds*', type: 'ENUM', constraints: INTERVALS]]
        command 'setSlideshowMode', [[name: 'Mode*', type: 'ENUM', constraints: MODES]]
        command 'setSlideshowOrder', [[name: 'Order*', type: 'ENUM', constraints: ORDERS]]
        command 'tvToggle'
        command 'tvKey', [[name: 'Key*', type: 'ENUM', constraints: TV_KEYS]]
        command 'reconnect'
    }

    preferences {
        input 'frameHost', 'text', title: 'Frame IP address or hostname', required: true
        input 'framePort', 'number', title: 'Frame port', defaultValue: 3000, required: true
        input 'authToken', 'password', title: 'Auth secret (only if auth is enabled on the frame)', required: false
        input 'tvPollMinutes', 'enum', title: 'Check TV power every',
              options: ['0': 'Never', '1': '1 minute', '5': '5 minutes', '15': '15 minutes'], defaultValue: '5'
        input 'enableDelete', 'bool', title: 'Allow the Delete Photo command',
              description: 'Deletes immediately (the file moves to the frame\'s data/deleted folder). Off by default so a rule or dashboard tap can\'t delete photos by accident.',
              defaultValue: false
        input 'txtEnable', 'bool', title: 'Enable description text logging', defaultValue: true
        input 'logEnable', 'bool', title: 'Enable debug logging (turns off after 30 minutes)', defaultValue: false
    }
}

// ---- lifecycle ----------------------------------------------------------

void installed() {
    sendEvent(name: 'numberOfButtons', value: BUTTONS.size())
    sendEvent(name: 'eventStream', value: 'disconnected')
}

void updated() {
    log.info "${device.displayName}: preferences updated"
    if (logEnable) runIn(1800, 'logsOff')
    initialize()
}

void initialize() {
    unschedule()
    sendEvent(name: 'numberOfButtons', value: BUTTONS.size())
    if (!frameHost) {
        log.warn "${device.displayName}: set the frame's IP address in preferences"
        return
    }
    state.reconnectDelay = 5
    connectEventStream()
    scheduleTvPoll()
    // Safety net in case the event stream silently stalls.
    runEvery30Minutes('refresh')
    refresh()
}

void logsOff() {
    device.updateSetting('logEnable', [value: 'false', type: 'bool'])
    log.info "${device.displayName}: debug logging disabled"
}

// ---- capability commands --------------------------------------------------

void on() { tvPower('on') }
void off() { tvPower('off') }

void play() { framePost('/api/slideshow/start', null, 'handleSlideshow') }
void pause() { framePost('/api/slideshow/pause', null, 'handleSlideshow') }
void stop() { pause() }

void refresh() {
    frameGet('/api/image/current', 'handleCurrentImage')
    frameGet('/api/slideshow/state', 'handleSlideshow')
    pollTv()
}

void push(button) {
    Integer n = button as Integer
    logDebug "push(${n})"
    sendEvent(name: 'pushed', value: n, isStateChange: true, descriptionText: "${device.displayName} button ${n} pushed")
    switch (n) {
        case 1: nextPhoto(); break
        case 2: previousPhoto(); break
        case 3: togglePlayPause(); break
        case 4: toggleFavorite(); break
        case 5: toggleFavoritesOnly(); break
        case 6: tvToggle(); break
        case 7: shuffle(); break
        default: log.warn "${device.displayName}: button ${n} is not assigned"
    }
}

// ---- custom commands ----------------------------------------------------

void nextPhoto() { frameGet('/api/image/next', 'handleCurrentImage') }
void previousPhoto() { frameGet('/api/image/previous', 'handleCurrentImage') }

void togglePlayPause() {
    device.currentValue('transportStatus') == 'playing' ? pause() : play()
}

void toggleFavorite() { framePost('/api/image/current/favorite', null, 'handleFavorite') }

// New random order (every photo once before repeats), starting now.
void shuffle() { framePost('/api/slideshow/shuffle', null, 'handleCurrentImage') }
// Back to the normal order for the current mode/order setting.
void unshuffle() { updateSettings([shuffle: false]) }

void deletePhoto() {
    if (!enableDelete) {
        log.warn "${device.displayName}: Delete Photo is disabled. Turn on 'Allow the Delete Photo command' in preferences."
        return
    }
    logInfo "deleting current photo ${device.currentValue('photoName')}"
    asynchttpDelete('handleDelete', requestParams('/api/image/current'))
}

void showFavorites() { setFavoritesOnly(true) }
void showAllPhotos() { setFavoritesOnly(false) }

void toggleFavoritesOnly() {
    setFavoritesOnly(device.currentValue('favoritesOnly') != 'on')
}

void setSlideInterval(seconds) { updateSettings([interval: seconds as Integer]) }
void setSlideshowMode(String mode) { updateSettings([mode: mode]) }
void setSlideshowOrder(String order) { updateSettings([order: order]) }

void tvToggle() { framePost('/api/tv/toggle', null, 'handleTvPower', 60) }

void tvKey(String key) { framePost('/api/tv/key', [key: key], 'handleTvKey') }

void reconnect() {
    state.reconnectDelay = 5
    connectEventStream()
}

// ---- helpers: actions ---------------------------------------------------

private void tvPower(String action) {
    logInfo "turning TV ${action}"
    // Turning on can take ~15s (Wake-on-LAN attempt, then the power key).
    framePost("/api/tv/${action}", null, 'handleTvPower', 60)
}

private void setFavoritesOnly(Boolean enabled) { updateSettings([favoritesOnly: enabled]) }

private void updateSettings(Map changes) {
    logDebug "updateSettings ${changes}"
    framePost('/api/settings', changes, 'handleSettingsResponse')
}

private void scheduleTvPoll() {
    switch (tvPollMinutes ?: '5') {
        case '1': runEvery1Minute('pollTv'); break
        case '5': runEvery5Minutes('pollTv'); break
        case '15': runEvery15Minutes('pollTv'); break
        default: break
    }
}

void pollTv() { frameGet('/api/tv/status', 'handleTvStatus') }

// ---- helpers: HTTP ------------------------------------------------------

private String baseUri() { "http://${frameHost}:${framePort ?: 3000}" }

private Map requestParams(String path, Map body = null, Integer timeout = 15) {
    Map p = [uri: baseUri(), path: path, contentType: 'application/json',
             requestContentType: 'application/json', timeout: timeout]
    if (body != null) p.body = body
    if (authToken) p.headers = ['X-Auth-Token': authToken]
    return p
}

private void frameGet(String path, String callback) {
    logDebug "GET ${path}"
    asynchttpGet(callback, requestParams(path))
}

private void framePost(String path, Map body, String callback, Integer timeout = 15) {
    logDebug "POST ${path} ${body ?: ''}"
    // The frame's POST routes accept an empty JSON body.
    asynchttpPost(callback, requestParams(path, body ?: [:], timeout))
}

private Map responseJson(resp, String what) {
    if (resp.hasError()) {
        String detail = ''
        try { detail = resp.getErrorData() ?: '' } catch (ignored) { }
        log.warn "${device.displayName}: ${what} failed (${resp.status}): ${resp.getErrorMessage()} ${detail}"
        return null
    }
    try {
        return resp.json as Map
    } catch (e) {
        log.warn "${device.displayName}: ${what} returned unreadable JSON: ${e.message}"
        return null
    }
}

// ---- response handlers --------------------------------------------------

void handleCurrentImage(resp, data) {
    Map json = responseJson(resp, 'photo request')
    if (!json) return
    if (json.image) updatePhoto(json.image as Map)
    if (json.settings) updateSettingsAttributes(json.settings as Map)
}

void handleSlideshow(resp, data) {
    Map json = responseJson(resp, 'slideshow request')
    if (!json) return
    if (json.isPlaying != null) updateTransport(json.isPlaying as Boolean)
    if (json.interval != null) updateAttr('slideInterval', json.interval as Integer)
}

void handleFavorite(resp, data) {
    Map json = responseJson(resp, 'favorite toggle')
    if (json?.isFavorite != null) updateAttr('photoFavorite', json.isFavorite ? 'true' : 'false')
}

void handleDelete(resp, data) {
    Map json = responseJson(resp, 'delete')
    if (!json) return
    logInfo 'photo deleted'
    if (json.nextImage) updatePhoto(json.nextImage as Map)
}

void handleSettingsResponse(resp, data) {
    Map json = responseJson(resp, 'settings update')
    if (json?.settings) updateSettingsAttributes(json.settings as Map)
}

void handleTvPower(resp, data) {
    Map json = responseJson(resp, 'TV power')
    if (json?.powerState) updateTvPower(json.powerState as String)
    // A failed or partial power change: re-read the real state.
    if (!json?.powerState || json.powerState == 'art') runIn(5, 'pollTv')
}

void handleTvStatus(resp, data) {
    Map json = responseJson(resp, 'TV status')
    if (!json) { updateTvPower('unknown'); return }
    updateTvPower(json.reachable ? (json.powerState as String) : 'unreachable')
}

void handleTvKey(resp, data) {
    Map json = responseJson(resp, 'TV key')
    if (json?.key) logDebug "TV key ${json.key} sent"
}

// ---- event stream (live updates) ----------------------------------------

private void connectEventStream() {
    if (!frameHost) return
    try { interfaces.eventStream.close() } catch (ignored) { }
    String url = "${baseUri()}/api/events"
    logDebug "connecting event stream ${url}"
    Map options = [:]
    if (authToken) options.headers = ['X-Auth-Token': authToken]
    interfaces.eventStream.connect(url, options)
}

void eventStreamStatus(String status) {
    logDebug "eventStreamStatus: ${status}"
    if (status.startsWith('START')) {
        state.reconnectDelay = 5
        updateAttr('eventStream', 'connected')
    } else if (status.startsWith('STOP') || status.startsWith('ERROR')) {
        updateAttr('eventStream', 'disconnected')
        // Back off up to 5 minutes between reconnect attempts.
        Integer delay = (state.reconnectDelay ?: 5) as Integer
        state.reconnectDelay = Math.min(delay * 2, 300)
        runIn(delay, 'connectEventStreamScheduled')
    }
}

void connectEventStreamScheduled() { connectEventStream() }

// Called by Hubitat with each Server-Sent Event's data.
void parse(String message) {
    if (!message) return
    String body = message.startsWith('data:') ? message.substring(5).trim() : message.trim()
    if (!body.startsWith('{')) return
    Map msg
    try {
        msg = parseJson(body) as Map
    } catch (e) {
        logDebug "ignoring unparseable event: ${e.message}"
        return
    }
    switch (msg.type) {
        case 'image':
            if (msg.image) updatePhoto(msg.image as Map)
            if (msg.settings) updateSettingsAttributes(msg.settings as Map)
            if (msg.isPlaying != null) updateTransport(msg.isPlaying as Boolean)
            break
        case 'favorite':
            if (msg.imageId == device.currentValue('photoId')) {
                updateAttr('photoFavorite', msg.isFavorite ? 'true' : 'false')
            }
            break
        case 'settings':
            if (msg.settings) updateSettingsAttributes(msg.settings as Map)
            break
        case 'slideshowState':
            if (msg.isPlaying != null) updateTransport(msg.isPlaying as Boolean)
            break
        default:
            break // rotate, duplicateScan, ...: not relevant to the hub
    }
}

// ---- attribute updates --------------------------------------------------

private void updatePhoto(Map image) {
    String url = "${baseUri()}/api/image/${image.id}/serve"
    updateAttr('photoId', image.id as Integer)
    updateAttr('photoName', image.filename as String)
    updateAttr('photoDate', image.dateTaken ? (image.dateTaken as String).take(10) : 'unknown')
    String place = [image.locationCity, image.locationCountry].findAll { it }.join(', ')
    updateAttr('photoLocation', place ?: 'unknown')
    updateAttr('photoFavorite', image.isFavorite ? 'true' : 'false')
    updateAttr('photoUrl', url)
    updateAttr('photoTile', "<img src='${url}' style='max-width:100%;max-height:100%;object-fit:contain'>")
}

private void updateSettingsAttributes(Map s) {
    if (s.favoritesOnly != null) updateAttr('favoritesOnly', s.favoritesOnly ? 'on' : 'off')
    if (s.shuffle != null) updateAttr('shuffle', s.shuffle ? 'on' : 'off')
    if (s.mode) updateAttr('slideshowMode', s.mode as String)
    if (s.order) updateAttr('slideshowOrder', s.order as String)
    if (s.interval != null) updateAttr('slideInterval', s.interval as Integer)
}

private void updateTransport(Boolean playing) {
    updateAttr('transportStatus', playing ? 'playing' : 'paused')
}

private void updateTvPower(String powerState) {
    updateAttr('tvPower', powerState)
    if (powerState in ['on', 'standby', 'art']) updateAttr('switch', powerState == 'on' ? 'on' : 'off')
}

private void updateAttr(String name, value) {
    if (device.currentValue(name) == value) return
    sendEvent(name: name, value: value, descriptionText: "${device.displayName} ${name} is ${value}")
    if (name in ['switch', 'transportStatus', 'favoritesOnly', 'shuffle', 'photoFavorite', 'tvPower']) logInfo "${name} is ${value}"
}

private void logInfo(String msg) { if (txtEnable) log.info "${device.displayName}: ${msg}" }
private void logDebug(String msg) { if (logEnable) log.debug "${device.displayName}: ${msg}" }

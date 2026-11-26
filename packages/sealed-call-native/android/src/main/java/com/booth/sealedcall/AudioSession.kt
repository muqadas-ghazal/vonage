package com.booth.sealedcall

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/**
 * Claims the microphone for a voice call, the way a native calling app does.
 *
 * Android arbitrates microphone access: only one app captures at a time, and the winner is
 * decided by audio focus and by the declared use case. An app that simply calls
 * getUserMedia is asking for hardware another process may already own, and the request
 * fails with NotReadableError — permission granted, device present, open refused.
 *
 * Two things change that:
 *
 *  - `MODE_IN_COMMUNICATION` declares this as a voice call, which raises capture priority
 *    and enables the hardware echo canceller.
 *  - `AUDIOFOCUS_GAIN` with `USAGE_VOICE_COMMUNICATION` *takes* focus, so a competing
 *    holder is told to stop.
 *
 * This is the Android counterpart of the AVAudioSession configuration on iOS. Chromium
 * inside the WebView still performs the capture itself, so this influences the OS
 * arbitration rather than controlling the capture directly — which is the same position a
 * native app is in before it registers with Telecom.
 */
object AudioSession {

  private var focusRequest: AudioFocusRequest? = null
  private var previousMode: Int? = null

  fun acquire(context: Context) {
    val manager = context.getSystemService(AudioManager::class.java) ?: return

    if (previousMode == null) previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    // Voice-call mode plays through the earpiece. A phone held out to watch the screen
    // then sounds silent. The loudspeaker is the output for this call.
    routeToSpeaker(manager)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attributes)
        // We do not pause for transient loss: a call keeps running, and handing the mic
        // back mid-sentence is worse than the notification sound that took focus.
        .setWillPauseWhenDucked(false)
        .setAcceptsDelayedFocusGain(false)
        .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        null,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN,
      )
    }
  }

  fun release(context: Context) {
    val manager = context.getSystemService(AudioManager::class.java) ?: return

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { manager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      manager.abandonAudioFocus(null)
    }
    focusRequest = null

    // Back to whatever the device was doing, or NORMAL if we never recorded it. Leaving
    // the mode in IN_COMMUNICATION affects every other app's audio routing.
    manager.mode = previousMode ?: AudioManager.MODE_NORMAL
    previousMode = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    }
    @Suppress("DEPRECATION")
    manager.isSpeakerphoneOn = false
  }

  private fun routeToSpeaker(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val speaker = manager.availableCommunicationDevices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
      }
      if (speaker != null && manager.setCommunicationDevice(speaker)) return
    }
    @Suppress("DEPRECATION")
    manager.isSpeakerphoneOn = true
  }

  /**
   * What the OS thinks, rather than what a JavaScript permissions library reports.
   *
   * Worth having separately: device labels in `enumerateDevices` are populated once *any*
   * capture permission is granted, so a page can look permitted for audio when only the
   * camera was allowed.
   */
  fun permissionState(context: Context): Map<String, Any> {
    fun granted(permission: String) =
      context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    val manager = context.getSystemService(AudioManager::class.java)
    return mapOf(
      "recordAudio" to granted(Manifest.permission.RECORD_AUDIO),
      "camera" to granted(Manifest.permission.CAMERA),
      "audioMode" to (manager?.mode ?: -1),
      "micMuted" to (manager?.isMicrophoneMute ?: false),
    )
  }
}

package com.booth.sealedcall

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SealedCallKeepAliveModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {

  override fun getName() = "SealedCallKeepAlive"

  /**
   * Claims the microphone for a voice call. Call this before the WebView captures,
   * otherwise Chromium asks for hardware another app may still own.
   */
  @ReactMethod
  fun prepareAudio(promise: Promise) {
    try {
      AudioSession.acquire(context)
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("prepare_audio_failed", error.message, error)
    }
  }

  @ReactMethod
  fun releaseAudio(promise: Promise) {
    try {
      AudioSession.release(context)
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("release_audio_failed", error.message, error)
    }
  }

  /** The OS's own view of the capture permissions and audio mode. */
  @ReactMethod
  fun permissionState(promise: Promise) {
    try {
      val state = AudioSession.permissionState(context)
      val map = Arguments.createMap()
      for ((key, value) in state) {
        when (value) {
          is Boolean -> map.putBoolean(key, value)
          is Int -> map.putInt(key, value)
          else -> map.putString(key, value.toString())
        }
      }
      promise.resolve(map)
    } catch (error: Throwable) {
      promise.reject("permission_state_failed", error.message, error)
    }
  }

  @ReactMethod
  fun start(title: String, body: String, promise: Promise) {
    try {
      KeepAliveService.start(context, title, body)
      promise.resolve(null)
    } catch (error: Throwable) {
      // Most likely cause: called while the app was in the background, which Android 14+
      // forbids for a microphone-typed service. Surface it rather than failing silently —
      // the call still works, it just will not survive backgrounding.
      promise.reject("keep_alive_start_failed", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      KeepAliveService.stop(context)
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("keep_alive_stop_failed", error.message, error)
    }
  }
}

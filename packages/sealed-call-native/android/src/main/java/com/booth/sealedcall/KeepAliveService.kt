package com.booth.sealedcall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the process alive, and the microphone ours, while the app is in the background.
 *
 * Without a foreground service Android throttles the WebView's media threads once the app
 * stops being visible: first jitter and packet loss, then a dropped call. The persistent
 * notification is the price the platform charges for that, and it is not optional.
 *
 * The camera is a separate matter — the OS revokes it in the background for every app, so
 * this service deliberately declares only the microphone type. Claiming the camera type
 * would not keep video flowing; it would just ask the user for more than we use.
 */
class KeepAliveService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Call in progress"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: "Tap to return to the call"

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Ongoing calls",
        // Low keeps it silent: the call itself is the alert, the notification is a handle.
        NotificationManager.IMPORTANCE_LOW,
      )
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    startForegroundCompat(buildNotification(title, body))
    return START_STICKY
  }

  private fun buildNotification(title: String, body: String): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    return builder
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(pending)
      .build()
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    private const val CHANNEL_ID = "sealed_call_ongoing"
    private const val NOTIFICATION_ID = 0x5EA1
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"

    fun start(context: Context, title: String, body: String) {
      val intent = Intent(context, KeepAliveService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_BODY, body)
      // Android 14+ throws if this is called while the app is in the background, which is
      // why the JS side starts it on join, when the call screen is necessarily visible.
      // startForegroundService arrived in O; below that a plain start is equivalent,
      // and minSdk here is 24.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }
  }
}

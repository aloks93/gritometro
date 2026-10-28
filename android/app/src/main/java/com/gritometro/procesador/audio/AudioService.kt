package com.gritometro.procesador.audio

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
import android.os.PowerManager
import com.gritometro.procesador.MainActivity
import com.gritometro.procesador.R

/**
 * Keeps live processing running with the screen off or in another app: a microphone foreground
 * service with a notification to open the app or stop. The audio itself lives in [AudioHub].
 */
class AudioService : Service() {
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            AudioHub.stopLive()
            stopSelf()
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Procesando en vivo", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, AudioService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Procesador de Audio")
            .setContentText(if (AudioHub.live.recording) "Grabando · procesando el micrófono" else "Procesando el micrófono en vivo")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Detener", stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= 30) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(ID, n)
        if (wake == null) {
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gritometro:live").apply { acquire(6 * 60 * 60 * 1000L) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "live"
        private const val ID = 1
        const val ACTION_STOP = "com.gritometro.procesador.STOP"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, AudioService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AudioService::class.java))
        }
    }
}

/** The app's audio, shared by the UI and the service */
object AudioHub {
    lateinit var live: LiveEngine
        private set
    private lateinit var app: Context
    /** Called when live processing stops from outside the UI (notification, lost mic) */
    @Volatile var onStopped: (() -> Unit)? = null

    fun init(context: Context) {
        if (::live.isInitialized) return
        app = context.applicationContext
        live = LiveEngine(app)
    }

    fun startLive(): Boolean {
        if (!live.start()) return false
        AudioService.start(app)
        return true
    }

    fun stopLive() {
        live.stop()
        AudioService.stop(app)
        onStopped?.invoke()
    }

    /** Refreshes the notification text (recording / not) */
    fun refreshNotification() {
        if (live.running) AudioService.start(app)
    }
}

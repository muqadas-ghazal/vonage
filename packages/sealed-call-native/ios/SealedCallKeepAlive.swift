import AVFoundation
import Foundation
import React

/**
 Keeps the microphone live while the app is in the background.

 WebKit mutes `getUserMedia` on a backgrounded app unless the host app declares the
 `audio` background mode, and it needs an active audio session configured for voice chat
 to keep routing. Those two together are what stop the call going silent when the user
 switches apps or locks the screen.

 There is nothing here for video, deliberately: iOS revokes camera access in the
 background for every app, native ones included. Video pauses and resumes on return.
 */
@objc(SealedCallKeepAlive)
class SealedCallKeepAlive: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(start:body:resolver:rejecter:)
  func start(
    _ title: String,
    body: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
      )
      try session.setActive(true, options: [])
      resolve(nil)
    } catch {
      reject("keep_alive_start_failed", error.localizedDescription, error)
    }
  }

  @objc(stop:rejecter:)
  func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      // Notify others so music and podcasts resume where the call interrupted them.
      try AVAudioSession.sharedInstance().setActive(
        false,
        options: [.notifyOthersOnDeactivation]
      )
      resolve(nil)
    } catch {
      reject("keep_alive_stop_failed", error.localizedDescription, error)
    }
  }
}

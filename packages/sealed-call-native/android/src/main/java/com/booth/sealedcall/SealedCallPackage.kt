package com.booth.sealedcall

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Autolinked by the React Native CLI, which finds this class by scanning the package.
 * No manual registration in MainApplication is needed.
 *
 * The `createViewManagers` return type matches ReactPackage exactly — React Native
 * declares it as `List<ViewManager<in Nothing, in Nothing>>`, and a friendlier-looking
 * signature such as `List<ViewManager<View, ReactShadowNode<*>>>` is not an override of
 * it, so Kotlin rejects the class.
 */
class SealedCallPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(SealedCallKeepAliveModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<in Nothing, in Nothing>> = emptyList()
}

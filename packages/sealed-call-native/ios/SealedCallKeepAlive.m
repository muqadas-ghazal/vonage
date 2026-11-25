#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(SealedCallKeepAlive, NSObject)

RCT_EXTERN_METHOD(start:(NSString *)title
                  body:(NSString *)body
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end

#import <AppKit/AppKit.h>
#import <Security/SecCode.h>
#import <Security/Security.h>

#include <napi.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

std::atomic<bool> environmentAlive{true};

struct Callbacks {
  Napi::FunctionReference request;
  Napi::FunctionReference ended;

  ~Callbacks() {
    if (!environmentAlive.load(std::memory_order_acquire)) {
      request.SuppressDestruct();
      ended.SuppressDestruct();
    }
  }
};

struct PendingCompletion {
  void (^handler)(NSError*);
  std::shared_ptr<Callbacks> callbacks;
};

std::unordered_map<std::string, PendingCompletion> pending;

NSString* String(const std::string& value) {
  return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
}

std::string Utf8(NSString* value) {
  if (value == nil) return {};
  const char* bytes = value.UTF8String;
  return bytes == nullptr ? std::string{} : std::string(bytes);
}

NSError* DragError() {
  return [NSError errorWithDomain:@"com.zts1.overlook.native-drag" code:1 userInfo:nil];
}

bool HasTrustedSignature(const std::string& expectedBundleId) {
  @autoreleasepool {
    NSString* expected = String(expectedBundleId);
    NSString* bundleId = NSBundle.mainBundle.bundleIdentifier;
    if (expected == nil || bundleId == nil || ![bundleId isEqualToString:expected]) return false;
    SecCodeRef code = nullptr;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess || code == nullptr) return false;
    const OSStatus valid = SecCodeCheckValidity(code, kSecCSStrictValidate, nullptr);
    if (valid != errSecSuccess) {
      CFRelease(code);
      return false;
    }
    CFDictionaryRef information = nullptr;
    const OSStatus copied = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
    CFRelease(code);
    if (copied != errSecSuccess || information == nullptr) return false;
    const auto* identifier = static_cast<CFStringRef>(CFDictionaryGetValue(information, kSecCodeInfoIdentifier));
    const auto* flagsValue = static_cast<CFNumberRef>(CFDictionaryGetValue(information, kSecCodeInfoFlags));
    std::uint32_t flags = 0;
    if (flagsValue != nullptr) CFNumberGetValue(flagsValue, kCFNumberSInt32Type, &flags);
    const bool trusted = identifier != nullptr && CFGetTypeID(identifier) == CFStringGetTypeID() &&
                         CFStringCompare(identifier, (__bridge CFStringRef)expected, 0) == kCFCompareEqualTo &&
                         (flags & kSecCodeSignatureAdhoc) == 0;
    CFRelease(information);
    return trusted;
  }
}

void CallRequest(const std::shared_ptr<Callbacks>& callbacks, NSString* requestId, NSString* token, NSString* path) {
  if (!environmentAlive.load(std::memory_order_acquire)) return;
  Napi::Env env = callbacks->request.Env();
  callbacks->request.Call({Napi::String::New(env, Utf8(requestId)), Napi::String::New(env, Utf8(token)), Napi::String::New(env, Utf8(path))});
}

void CallEnded(const std::shared_ptr<Callbacks>& callbacks) {
  if (!environmentAlive.load(std::memory_order_acquire)) return;
  callbacks->ended.Call({});
}

}  // namespace

@interface OverlookPromiseProvider : NSFilePromiseProvider
@property(nonatomic, copy) NSPasteboardType overlookInternalType;
@property(nonatomic, copy) NSString* overlookInternalPayload;
@end

@implementation OverlookPromiseProvider
- (NSArray<NSPasteboardType>*)writableTypesForPasteboard:(NSPasteboard*)pasteboard {
  NSArray<NSPasteboardType>* inherited = [super writableTypesForPasteboard:pasteboard];
  return self.overlookInternalType.length == 0 ? inherited : [inherited arrayByAddingObject:self.overlookInternalType];
}

- (id)pasteboardPropertyListForType:(NSPasteboardType)type {
  if ([type isEqualToString:self.overlookInternalType]) return self.overlookInternalPayload;
  return [super pasteboardPropertyListForType:type];
}
@end

@interface OverlookPromiseDelegate : NSObject <NSFilePromiseProviderDelegate> {
 @private
  std::shared_ptr<Callbacks> callbacks_;
}
@property(nonatomic, copy) NSString* token;
@property(nonatomic, copy) NSString* fileName;
- (instancetype)initWithCallbacks:(std::shared_ptr<Callbacks>)callbacks;
@end

@implementation OverlookPromiseDelegate
- (instancetype)initWithCallbacks:(std::shared_ptr<Callbacks>)callbacks {
  self = [super init];
  if (self != nil) callbacks_ = std::move(callbacks);
  return self;
}

- (NSString*)filePromiseProvider:(NSFilePromiseProvider*)filePromiseProvider fileNameForType:(NSString*)fileType {
  return self.fileName;
}

- (NSOperationQueue*)operationQueueForFilePromiseProvider:(NSFilePromiseProvider*)filePromiseProvider {
  return NSOperationQueue.mainQueue;
}

- (void)filePromiseProvider:(NSFilePromiseProvider*)filePromiseProvider
         writePromiseToURL:(NSURL*)url
         completionHandler:(void (^)(NSError* _Nullable))completionHandler {
  if (url == nil || !url.isFileURL || !environmentAlive.load(std::memory_order_acquire)) {
    completionHandler(DragError());
    return;
  }
  NSString* requestId = NSUUID.UUID.UUIDString;
  pending.emplace(Utf8(requestId), PendingCompletion{[completionHandler copy], callbacks_});
  CallRequest(callbacks_, requestId, self.token, url.path);
}
@end

@interface OverlookDragSource : NSObject <NSDraggingSource> {
 @private
  std::shared_ptr<Callbacks> callbacks_;
}
@property(nonatomic, strong) NSDraggingSession* session;
@property(nonatomic, strong) NSArray<OverlookPromiseDelegate*>* promiseDelegates;
- (instancetype)initWithCallbacks:(std::shared_ptr<Callbacks>)callbacks;
@end

static NSMutableArray<OverlookDragSource*>* activeSources;

@implementation OverlookDragSource
- (instancetype)initWithCallbacks:(std::shared_ptr<Callbacks>)callbacks {
  self = [super init];
  if (self != nil) callbacks_ = std::move(callbacks);
  return self;
}

- (NSDragOperation)draggingSession:(NSDraggingSession*)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}

- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession*)session {
  return YES;
}

- (void)draggingSession:(NSDraggingSession*)session
             endedAtPoint:(NSPoint)screenPoint
                operation:(NSDragOperation)operation {
  CallEnded(callbacks_);
  self.session = nil;
  self.promiseDelegates = nil;
  [activeSources removeObject:self];
}
@end

namespace {

Napi::Value Status(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsString()) return Napi::Boolean::New(info.Env(), false);
  return Napi::Boolean::New(info.Env(), HasTrustedSignature(info[0].As<Napi::String>().Utf8Value()));
}

Napi::Value StartDrag(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 7 || !info[0].IsString() || !info[1].IsBuffer() || !info[2].IsArray() ||
      !info[3].IsString() || !info[4].IsString() || !info[5].IsFunction() || !info[6].IsFunction()) {
    return Napi::Boolean::New(env, false);
  }
  if (!HasTrustedSignature(info[0].As<Napi::String>().Utf8Value())) return Napi::Boolean::New(env, false);
  Napi::Buffer<std::uint8_t> handle = info[1].As<Napi::Buffer<std::uint8_t>>();
  if (handle.Length() < sizeof(void*)) return Napi::Boolean::New(env, false);
  void* pointer = nullptr;
  std::memcpy(&pointer, handle.Data(), sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  NSEvent* event = NSApp.currentEvent;
  if (view == nil || event == nil || view.window == nil) return Napi::Boolean::New(env, false);

  auto callbacks = std::make_shared<Callbacks>();
  callbacks->request = Napi::Persistent(info[5].As<Napi::Function>());
  callbacks->ended = Napi::Persistent(info[6].As<Napi::Function>());
  NSString* internalType = String(info[3].As<Napi::String>().Utf8Value());
  NSString* internalPayload = String(info[4].As<Napi::String>().Utf8Value());
  Napi::Array input = info[2].As<Napi::Array>();
  if (input.Length() == 0 || input.Length() > 100) return Napi::Boolean::New(env, false);

  NSMutableArray<NSDraggingItem*>* draggingItems = [NSMutableArray arrayWithCapacity:input.Length()];
  NSMutableArray<OverlookPromiseDelegate*>* delegates = [NSMutableArray arrayWithCapacity:input.Length()];
  for (std::uint32_t index = 0; index < input.Length(); ++index) {
    Napi::Value value = input[index];
    if (!value.IsObject()) return Napi::Boolean::New(env, false);
    Napi::Object item = value.As<Napi::Object>();
    Napi::Value tokenValue = item.Get("token");
    Napi::Value nameValue = item.Get("fileName");
    Napi::Value typeValue = item.Get("fileType");
    if (!tokenValue.IsString() || !nameValue.IsString() || !typeValue.IsString()) return Napi::Boolean::New(env, false);
    std::string rawToken = tokenValue.As<Napi::String>().Utf8Value();
    std::string rawName = nameValue.As<Napi::String>().Utf8Value();
    std::string rawType = typeValue.As<Napi::String>().Utf8Value();
    if (rawToken.find('\0') != std::string::npos || rawName.find('\0') != std::string::npos || rawType.find('\0') != std::string::npos ||
        rawName == "." || rawName == "..") {
      return Napi::Boolean::New(env, false);
    }
    NSString* token = String(rawToken);
    NSString* name = String(rawName);
    NSString* type = String(rawType);
    if (token.length == 0 || name.length == 0 || [name containsString:@"/"] || [name containsString:@"\\"] ||
        [name containsString:@":"] || type.length == 0) {
      return Napi::Boolean::New(env, false);
    }

    OverlookPromiseDelegate* delegate = [[OverlookPromiseDelegate alloc] initWithCallbacks:callbacks];
    delegate.token = token;
    delegate.fileName = name;
    OverlookPromiseProvider* provider = [[OverlookPromiseProvider alloc] initWithFileType:type delegate:delegate];
    provider.overlookInternalType = internalType;
    provider.overlookInternalPayload = internalPayload;
    NSDraggingItem* draggingItem = [[NSDraggingItem alloc] initWithPasteboardWriter:provider];
    NSImage* icon = [NSImage imageNamed:NSImageNameMultipleDocuments];
    NSPoint location = [view convertPoint:event.locationInWindow fromView:nil];
    const CGFloat offset = static_cast<CGFloat>(index % 5) * 3.0;
    [draggingItem setDraggingFrame:NSMakeRect(location.x + offset - 24.0, location.y - offset - 24.0, 48.0, 48.0) contents:icon];
    [draggingItems addObject:draggingItem];
    [delegates addObject:delegate];
  }

  if (activeSources == nil) activeSources = [[NSMutableArray alloc] init];
  OverlookDragSource* source = [[OverlookDragSource alloc] initWithCallbacks:callbacks];
  source.promiseDelegates = delegates;
  [activeSources addObject:source];
  source.session = [view beginDraggingSessionWithItems:draggingItems event:event source:source];
  if (source.session == nil) {
    [activeSources removeObject:source];
    CallEnded(callbacks);
    return Napi::Boolean::New(env, false);
  }
  source.session.animatesToStartingPositionsOnCancelOrFail = YES;
  return Napi::Boolean::New(env, true);
}

void CompleteOnMain(std::string requestId, bool failed) {
  auto found = pending.find(requestId);
  if (found == pending.end()) return;
  void (^handler)(NSError*) = found->second.handler;
  pending.erase(found);
  handler(failed ? DragError() : nil);
}

Napi::Value Complete(const Napi::CallbackInfo& info) {
  if (info.Length() != 2 || !info[0].IsString() || (!info[1].IsNull() && !info[1].IsString())) return info.Env().Undefined();
  std::string requestId = info[0].As<Napi::String>().Utf8Value();
  const bool failed = !info[1].IsNull();
  if (NSThread.isMainThread) CompleteOnMain(std::move(requestId), failed);
  else dispatch_async(dispatch_get_main_queue(), ^{ CompleteOnMain(requestId, failed); });
  return info.Env().Undefined();
}

Napi::Value CancelAll(const Napi::CallbackInfo& info) {
  auto cancel = [] {
    std::vector<std::string> requestIds;
    requestIds.reserve(pending.size());
    for (const auto& entry : pending) requestIds.push_back(entry.first);
    for (const std::string& requestId : requestIds) CompleteOnMain(requestId, true);
  };
  if (NSThread.isMainThread) cancel();
  else dispatch_async(dispatch_get_main_queue(), cancel);
  return info.Env().Undefined();
}

void Cleanup(void*) {
  environmentAlive.store(false, std::memory_order_release);
  pending.clear();
  activeSources = nil;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  exports.Set("status", Napi::Function::New(env, Status));
  exports.Set("startDrag", Napi::Function::New(env, StartDrag));
  exports.Set("complete", Napi::Function::New(env, Complete));
  exports.Set("cancelAll", Napi::Function::New(env, CancelAll));
  return exports;
}

}  // namespace

NODE_API_MODULE(overlook_native_drag, Init)

#import <CoreLocation/CoreLocation.h>
#import <Photos/Photos.h>
#import <Security/SecCode.h>
#import <Security/Security.h>

#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace {

std::atomic<std::uint64_t> cancellationEpoch{0};
std::mutex requestMutex;
std::vector<PHAssetResourceDataRequestID> activeRequests;

NSString* String(const std::string& value) {
  return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
}

std::string Utf8(NSString* value) {
  if (value == nil) return {};
  const char* bytes = value.UTF8String;
  return bytes == nullptr ? std::string{} : std::string(bytes);
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

PHAccessLevel Access(const std::string& value) {
  return value == "add-only" ? PHAccessLevelAddOnly : PHAccessLevelReadWrite;
}

std::string AuthorizationName(PHAuthorizationStatus status) {
  switch (status) {
    case PHAuthorizationStatusNotDetermined:
      return "not-determined";
    case PHAuthorizationStatusRestricted:
      return "restricted";
    case PHAuthorizationStatusDenied:
      return "denied";
    case PHAuthorizationStatusAuthorized:
      return "authorized";
    case PHAuthorizationStatusLimited:
      return "limited";
  }
  return "denied";
}

PHAssetResource* OriginalResource(PHAsset* asset) {
  NSArray<PHAssetResource*>* resources = [PHAssetResource assetResourcesForAsset:asset];
  for (PHAssetResource* resource in resources) {
    if (resource.type == PHAssetResourceTypePhoto || resource.type == PHAssetResourceTypeVideo ||
        resource.type == PHAssetResourceTypeFullSizePhoto || resource.type == PHAssetResourceTypeFullSizeVideo) {
      return resource;
    }
  }
  return resources.firstObject;
}

std::string IsoDate(NSDate* date) {
  if (date == nil) return {};
  NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return Utf8([formatter stringFromDate:date]);
}

NSDate* ParseDate(const std::string& value) {
  if (value.empty()) return nil;
  NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate* date = [formatter dateFromString:String(value)];
  if (date != nil) return date;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:String(value)];
}

struct AssetRecord {
  std::string id;
  std::string fileName;
  std::string mediaType;
  std::string createdAt;
  std::string path;
  std::int64_t width = 0;
  std::int64_t height = 0;
  bool hasLocation = false;
  double latitude = 0;
  double longitude = 0;
};

AssetRecord Record(PHAsset* asset, PHAssetResource* resource) {
  AssetRecord record = {
      Utf8(asset.localIdentifier),
      Utf8(resource.originalFilename),
      asset.mediaType == PHAssetMediaTypeVideo ? "video" : "image",
      IsoDate(asset.creationDate),
      {},
      static_cast<std::int64_t>(asset.pixelWidth),
      static_cast<std::int64_t>(asset.pixelHeight),
  };
  if (asset.location != nil) {
    record.hasLocation = true;
    record.latitude = asset.location.coordinate.latitude;
    record.longitude = asset.location.coordinate.longitude;
  }
  return record;
}

Napi::Object JsAsset(Napi::Env env, const AssetRecord& asset, bool includePath) {
  Napi::Object output = Napi::Object::New(env);
  output.Set("id", asset.id);
  output.Set("fileName", asset.fileName);
  output.Set("mediaType", asset.mediaType);
  output.Set("width", Napi::Number::New(env, static_cast<double>(asset.width)));
  output.Set("height", Napi::Number::New(env, static_cast<double>(asset.height)));
  output.Set("createdAt", asset.createdAt.empty() ? env.Null() : Napi::String::New(env, asset.createdAt));
  output.Set("latitude", asset.hasLocation ? Napi::Number::New(env, asset.latitude) : env.Null());
  output.Set("longitude", asset.hasLocation ? Napi::Number::New(env, asset.longitude) : env.Null());
  if (includePath) output.Set("path", asset.path);
  return output;
}

void RegisterRequest(PHAssetResourceDataRequestID requestId) {
  std::lock_guard<std::mutex> lock(requestMutex);
  activeRequests.push_back(requestId);
}

void UnregisterRequest(PHAssetResourceDataRequestID requestId) {
  std::lock_guard<std::mutex> lock(requestMutex);
  activeRequests.erase(std::remove(activeRequests.begin(), activeRequests.end(), requestId), activeRequests.end());
}

class MaterializeWorker final : public Napi::AsyncWorker {
 public:
  MaterializeWorker(Napi::Function callback, std::vector<std::string> assetIds, std::string destination)
      : Napi::AsyncWorker(callback), assetIds_(std::move(assetIds)), destination_(std::move(destination)), epoch_(cancellationEpoch.load()) {}

  void Execute() override {
    @autoreleasepool {
      NSFileManager* files = NSFileManager.defaultManager;
      NSString* directory = String(destination_);
      auto cleanupStaged = [&]() {
        for (const AssetRecord& staged : output_) {
          [files removeItemAtPath:String(staged.path) error:nil];
        }
        output_.clear();
      };
      for (const std::string& identifier : assetIds_) {
        if (cancellationEpoch.load() != epoch_) {
          cleanupStaged();
          SetError("Photos import cancelled");
          return;
        }
        PHFetchResult<PHAsset*>* fetched = [PHAsset fetchAssetsWithLocalIdentifiers:@[ String(identifier) ] options:nil];
        PHAsset* asset = fetched.firstObject;
        PHAssetResource* resource = asset == nil ? nil : OriginalResource(asset);
        NSString* originalName = resource.originalFilename.lastPathComponent;
        if (asset == nil || resource == nil || originalName.length == 0 || ![originalName isEqualToString:resource.originalFilename]) {
          cleanupStaged();
          SetError("Photos asset is unavailable");
          return;
        }
        NSString* stem = originalName.stringByDeletingPathExtension;
        NSString* extension = originalName.pathExtension;
        NSString* name = originalName;
        std::uint32_t suffix = 2;
        while ([files fileExistsAtPath:[directory stringByAppendingPathComponent:name]]) {
          NSString* numbered = [NSString stringWithFormat:@"%@ (%u)", stem, suffix++];
          name = extension.length == 0 ? numbered : [numbered stringByAppendingPathExtension:extension];
        }
        NSString* destinationPath = [directory stringByAppendingPathComponent:name];
        if (![files createFileAtPath:destinationPath contents:nil attributes:@{NSFilePosixPermissions : @0600}]) {
          cleanupStaged();
          SetError("Photos staging file could not be created");
          return;
        }
        NSFileHandle* handle = [NSFileHandle fileHandleForWritingAtPath:destinationPath];
        if (handle == nil) {
          [files removeItemAtPath:destinationPath error:nil];
          cleanupStaged();
          SetError("Photos staging file could not be opened");
          return;
        }
        PHAssetResourceRequestOptions* options = [[PHAssetResourceRequestOptions alloc] init];
        options.networkAccessAllowed = YES;
        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block NSError* transferError = nil;
        PHAssetResourceDataRequestID requestId = [PHAssetResourceManager.defaultManager
            requestDataForAssetResource:resource
                            options:options
                dataReceivedHandler:^(NSData* data) {
                  if (transferError != nil) return;
                  NSError* writeError = nil;
                  [handle writeData:data error:&writeError];
                  if (writeError != nil) transferError = writeError;
                }
                  completionHandler:^(NSError* error) {
                    if (transferError == nil) transferError = error;
                    dispatch_semaphore_signal(completed);
                  }];
        RegisterRequest(requestId);
        dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
        UnregisterRequest(requestId);
        [handle closeFile];
        if (transferError != nil || cancellationEpoch.load() != epoch_) {
          [files removeItemAtPath:destinationPath error:nil];
          cleanupStaged();
          SetError(cancellationEpoch.load() != epoch_ ? "Photos import cancelled" : Utf8(transferError.localizedDescription));
          return;
        }
        AssetRecord record = Record(asset, resource);
        record.fileName = Utf8(name);
        record.path = Utf8(destinationPath);
        output_.push_back(std::move(record));
      }
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    Napi::Array assets = Napi::Array::New(Env(), output_.size());
    for (std::size_t index = 0; index < output_.size(); ++index) assets.Set(index, JsAsset(Env(), output_[index], true));
    Callback().Call({Env().Null(), assets});
  }

  void OnError(const Napi::Error& error) override {
    Napi::HandleScope scope(Env());
    Callback().Call({Napi::String::New(Env(), error.Message()), Env().Undefined()});
  }

 private:
  std::vector<std::string> assetIds_;
  std::string destination_;
  std::uint64_t epoch_;
  std::vector<AssetRecord> output_;
};

struct ExportRecord {
  std::string path;
  std::string fileName;
  std::string mediaType;
  std::string createdAt;
  bool hasLocation = false;
  double latitude = 0;
  double longitude = 0;
};

class ExportWorker final : public Napi::AsyncWorker {
 public:
  ExportWorker(Napi::Function callback, std::vector<ExportRecord> assets)
      : Napi::AsyncWorker(callback), assets_(std::move(assets)), epoch_(cancellationEpoch.load()) {}

  void Execute() override {
    @autoreleasepool {
      if (cancellationEpoch.load() != epoch_) {
        SetError("Photos export cancelled");
        return;
      }
      dispatch_semaphore_t completed = dispatch_semaphore_create(0);
      __block BOOL succeeded = NO;
      __block NSError* operationError = nil;
      [PHPhotoLibrary.sharedPhotoLibrary
          performChanges:^{
            for (const ExportRecord& asset : assets_) {
              PHAssetCreationRequest* request = [PHAssetCreationRequest creationRequestForAsset];
              request.creationDate = ParseDate(asset.createdAt);
              if (asset.hasLocation) request.location = [[CLLocation alloc] initWithLatitude:asset.latitude longitude:asset.longitude];
              PHAssetResourceCreationOptions* options = [[PHAssetResourceCreationOptions alloc] init];
              options.originalFilename = String(asset.fileName);
              PHAssetResourceType type = asset.mediaType == "video" ? PHAssetResourceTypeVideo : PHAssetResourceTypePhoto;
              [request addResourceWithType:type fileURL:[NSURL fileURLWithPath:String(asset.path)] options:options];
            }
          }
          completionHandler:^(BOOL success, NSError* error) {
            succeeded = success;
            operationError = error;
            dispatch_semaphore_signal(completed);
          }];
      dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
      if (!succeeded) SetError(operationError == nil ? "Apple Photos rejected the export" : Utf8(operationError.localizedDescription));
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    Callback().Call({Env().Null()});
  }

  void OnError(const Napi::Error& error) override {
    Napi::HandleScope scope(Env());
    Callback().Call({Napi::String::New(Env(), error.Message())});
  }

 private:
  std::vector<ExportRecord> assets_;
  std::uint64_t epoch_;
};

Napi::Value Status(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsString()) return Napi::Boolean::New(info.Env(), false);
  return Napi::Boolean::New(info.Env(), HasTrustedSignature(info[0].As<Napi::String>().Utf8Value()));
}

Napi::Value Authorization(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsString()) return Napi::String::New(info.Env(), "denied");
  PHAuthorizationStatus status = [PHPhotoLibrary authorizationStatusForAccessLevel:Access(info[0].As<Napi::String>().Utf8Value())];
  return Napi::String::New(info.Env(), AuthorizationName(status));
}

Napi::Value RequestAuthorization(const Napi::CallbackInfo& info) {
  if (info.Length() != 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsFunction() ||
      !HasTrustedSignature(info[0].As<Napi::String>().Utf8Value())) {
    return info.Env().Undefined();
  }
  auto* callback = new Napi::ThreadSafeFunction(
      Napi::ThreadSafeFunction::New(info.Env(), info[2].As<Napi::Function>(), "PhotoKit authorization", 0, 1));
  PHAccessLevel access = Access(info[1].As<Napi::String>().Utf8Value());
  [PHPhotoLibrary requestAuthorizationForAccessLevel:access
                                             handler:^(PHAuthorizationStatus status) {
                                               std::string name = AuthorizationName(status);
                                               callback->BlockingCall([name](Napi::Env env, Napi::Function function) {
                                                 function.Call({Napi::String::New(env, name)});
                                               });
                                               callback->Release();
                                               delete callback;
                                             }];
  return info.Env().Undefined();
}

Napi::Value Assets(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsString() || !HasTrustedSignature(info[0].As<Napi::String>().Utf8Value())) {
    return Napi::Array::New(env);
  }
  PHFetchOptions* options = [[PHFetchOptions alloc] init];
  options.fetchLimit = 5000;
  options.sortDescriptors = @[ [NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO] ];
  PHFetchResult<PHAsset*>* fetched = [PHAsset fetchAssetsWithOptions:options];
  std::vector<AssetRecord> records;
  records.reserve(fetched.count);
  for (NSUInteger index = 0; index < fetched.count; ++index) {
    PHAsset* asset = [fetched objectAtIndex:index];
    if (asset.mediaType != PHAssetMediaTypeImage && asset.mediaType != PHAssetMediaTypeVideo) continue;
    PHAssetResource* resource = OriginalResource(asset);
    if (resource == nil || resource.originalFilename.length == 0) continue;
    records.push_back(Record(asset, resource));
  }
  Napi::Array output = Napi::Array::New(env, records.size());
  for (std::size_t index = 0; index < records.size(); ++index) output.Set(index, JsAsset(env, records[index], false));
  return output;
}

Napi::Value Materialize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 4 || !info[0].IsString() || !info[1].IsArray() || !info[2].IsString() || !info[3].IsFunction() ||
      !HasTrustedSignature(info[0].As<Napi::String>().Utf8Value())) {
    return env.Undefined();
  }
  Napi::Array input = info[1].As<Napi::Array>();
  if (input.Length() == 0 || input.Length() > 1000) return env.Undefined();
  std::vector<std::string> assetIds;
  assetIds.reserve(input.Length());
  for (std::uint32_t index = 0; index < input.Length(); ++index) {
    Napi::Value value = input.Get(index);
    if (!value.IsString()) return env.Undefined();
    assetIds.push_back(value.As<Napi::String>().Utf8Value());
  }
  (new MaterializeWorker(info[3].As<Napi::Function>(), std::move(assetIds), info[2].As<Napi::String>().Utf8Value()))->Queue();
  return env.Undefined();
}

Napi::Value ExportAssets(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 3 || !info[0].IsString() || !info[1].IsArray() || !info[2].IsFunction() ||
      !HasTrustedSignature(info[0].As<Napi::String>().Utf8Value())) {
    return env.Undefined();
  }
  Napi::Array input = info[1].As<Napi::Array>();
  if (input.Length() == 0 || input.Length() > 100) return env.Undefined();
  std::vector<ExportRecord> assets;
  assets.reserve(input.Length());
  for (std::uint32_t index = 0; index < input.Length(); ++index) {
    Napi::Value value = input.Get(index);
    if (!value.IsObject()) return env.Undefined();
    Napi::Object item = value.As<Napi::Object>();
    if (!item.Get("path").IsString() || !item.Get("fileName").IsString() || !item.Get("mediaType").IsString()) return env.Undefined();
    ExportRecord record;
    record.path = item.Get("path").As<Napi::String>().Utf8Value();
    record.fileName = item.Get("fileName").As<Napi::String>().Utf8Value();
    record.mediaType = item.Get("mediaType").As<Napi::String>().Utf8Value();
    if (item.Get("createdAt").IsString()) record.createdAt = item.Get("createdAt").As<Napi::String>().Utf8Value();
    Napi::Value latitude = item.Get("latitude");
    Napi::Value longitude = item.Get("longitude");
    if (latitude.IsNumber() && longitude.IsNumber()) {
      record.latitude = latitude.As<Napi::Number>().DoubleValue();
      record.longitude = longitude.As<Napi::Number>().DoubleValue();
      record.hasLocation = std::isfinite(record.latitude) && std::isfinite(record.longitude) && record.latitude >= -90 &&
                           record.latitude <= 90 && record.longitude >= -180 && record.longitude <= 180;
    }
    assets.push_back(std::move(record));
  }
  (new ExportWorker(info[2].As<Napi::Function>(), std::move(assets)))->Queue();
  return env.Undefined();
}

Napi::Value CancelAll(const Napi::CallbackInfo& info) {
  cancellationEpoch.fetch_add(1);
  std::vector<PHAssetResourceDataRequestID> requests;
  {
    std::lock_guard<std::mutex> lock(requestMutex);
    requests = activeRequests;
  }
  for (PHAssetResourceDataRequestID requestId : requests) [PHAssetResourceManager.defaultManager cancelDataRequest:requestId];
  return info.Env().Undefined();
}

void Cleanup(void*) {
  cancellationEpoch.fetch_add(1);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  exports.Set("status", Napi::Function::New(env, Status));
  exports.Set("authorization", Napi::Function::New(env, Authorization));
  exports.Set("requestAuthorization", Napi::Function::New(env, RequestAuthorization));
  exports.Set("assets", Napi::Function::New(env, Assets));
  exports.Set("materialize", Napi::Function::New(env, Materialize));
  exports.Set("exportAssets", Napi::Function::New(env, ExportAssets));
  exports.Set("cancelAll", Napi::Function::New(env, CancelAll));
  return exports;
}

}  // namespace

NODE_API_MODULE(overlook_photokit, Init)

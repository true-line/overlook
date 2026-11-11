#import <FileProvider/FileProvider.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString* const GroupIdentifier = @"Z5DM34QS5U.com.zts1.overlook.file-provider";

static NSError* Unavailable(void) {
  return [NSError errorWithDomain:NSFileProviderErrorDomain code:NSFileProviderErrorNotAuthenticated userInfo:nil];
}

static NSError* ReadOnly(void) {
  return [NSError errorWithDomain:NSCocoaErrorDomain code:NSFileWriteNoPermissionError userInfo:nil];
}

@interface OverlookProviderItem : NSObject <NSFileProviderItem>
@property(nonatomic, copy) NSFileProviderItemIdentifier itemIdentifier;
@property(nonatomic, copy) NSFileProviderItemIdentifier parentItemIdentifier;
@property(nonatomic, copy) NSString* filename;
@property(nonatomic, copy) UTType* contentType;
@property(nonatomic, copy) NSNumber* documentSize;
@property(nonatomic, copy) NSDate* contentModificationDate;
@property(nonatomic) NSFileProviderItemCapabilities capabilities;
@property(nonatomic) BOOL dataless;
+ (nullable instancetype)itemFromDictionary:(NSDictionary*)value;
@end

@implementation OverlookProviderItem
- (NSFileProviderContentPolicy)contentPolicy API_AVAILABLE(macos(13.0)) {
  return self.dataless ? NSFileProviderContentPolicyDownloadLazily : NSFileProviderContentPolicyInherited;
}

+ (nullable instancetype)itemFromDictionary:(NSDictionary*)value {
  NSString* identifier = value[@"id"];
  NSString* parent = value[@"parentId"];
  NSString* name = value[@"name"];
  NSString* type = value[@"contentType"];
  NSNumber* size = value[@"size"];
  NSNumber* dataless = value[@"dataless"];
  NSString* modified = value[@"modifiedAt"];
  if (![identifier isKindOfClass:NSString.class] || identifier.length == 0 ||
      ![parent isKindOfClass:NSString.class] || parent.length == 0 ||
      ![name isKindOfClass:NSString.class] || name.length == 0 ||
      ![type isKindOfClass:NSString.class] || type.length == 0 ||
      ![size isKindOfClass:NSNumber.class] || size.longLongValue < 0 ||
      ![dataless isKindOfClass:NSNumber.class] ||
      ![modified isKindOfClass:NSString.class]) return nil;
  NSDate* modifiedDate = [NSISO8601DateFormatter.new dateFromString:modified];
  if (modifiedDate == nil) return nil;
  OverlookProviderItem* item = [[self alloc] init];
  item.itemIdentifier = identifier;
  item.parentItemIdentifier = [parent isEqual:@"root"] ? NSFileProviderRootContainerItemIdentifier : parent;
  item.filename = name;
  item.contentType = [UTType typeWithIdentifier:type] ?: UTTypeData;
  item.documentSize = size;
  item.contentModificationDate = modifiedDate;
  item.dataless = dataless.boolValue;
  item.capabilities = [item.contentType conformsToType:UTTypeFolder]
      ? NSFileProviderItemCapabilitiesAllowsReading | NSFileProviderItemCapabilitiesAllowsContentEnumerating
      : NSFileProviderItemCapabilitiesAllowsReading;
  return item;
}
@end

@interface OverlookTransport : NSObject
- (NSURLSessionDataTask*)dataRequest:(NSString*)path completion:(void (^)(NSData*, NSError*))completion;
- (NSURLSessionDownloadTask*)downloadItem:(NSString*)identifier completion:(void (^)(NSURL*, NSError*))completion;
@end

@implementation OverlookTransport
- (NSDictionary*)endpoint {
  NSURL* group = [NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:GroupIdentifier];
  NSData* data = group == nil ? nil : [NSData dataWithContentsOfURL:[group URLByAppendingPathComponent:@"endpoint.json"]];
  if (data == nil) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

- (NSMutableURLRequest*)request:(NSString*)path method:(NSString*)method {
  NSDictionary* endpoint = [self endpoint];
  NSNumber* version = endpoint[@"version"];
  NSNumber* port = endpoint[@"port"];
  NSString* token = endpoint[@"token"];
  if (![version isKindOfClass:NSNumber.class] || version.integerValue != 1 ||
      ![port isKindOfClass:NSNumber.class] || port.integerValue < 1 || port.integerValue > 65535 ||
      ![token isKindOfClass:NSString.class] || token.length < 32) return nil;
  NSURL* url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@%@", port, path]];
  NSMutableURLRequest* request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = method;
  [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  return request;
}

- (NSURLSessionDataTask*)dataRequest:(NSString*)path completion:(void (^)(NSData*, NSError*))completion {
  NSMutableURLRequest* request = [self request:path method:@"GET"];
  if (request == nil) {
    completion(nil, Unavailable());
    return nil;
  }
  NSURLSessionDataTask* task = [NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData* data, NSURLResponse* response, NSError* error) {
    NSInteger status = [(NSHTTPURLResponse*)response statusCode];
    completion(status == 200 ? data : nil, status == 200 ? error : Unavailable());
  }];
  [task resume];
  return task;
}

- (NSURLSessionDownloadTask*)downloadItem:(NSString*)identifier completion:(void (^)(NSURL*, NSError*))completion {
  NSString* encoded = [identifier stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLQueryAllowedCharacterSet];
  NSMutableURLRequest* request = [self request:[@"/v1/materialize?id=" stringByAppendingString:encoded] method:@"GET"];
  if (request == nil) {
    completion(nil, Unavailable());
    return nil;
  }
  NSURLSessionDownloadTask* task = [NSURLSession.sharedSession downloadTaskWithRequest:request completionHandler:^(NSURL* location, NSURLResponse* response, NSError* error) {
    NSInteger status = [(NSHTTPURLResponse*)response statusCode];
    completion(status == 200 ? location : nil, status == 200 ? error : Unavailable());
  }];
  [task resume];
  return task;
}
@end

@interface OverlookEnumerator : NSObject <NSFileProviderEnumerator>
- (instancetype)initWithParent:(NSFileProviderItemIdentifier)parent transport:(OverlookTransport*)transport;
@end

@implementation OverlookEnumerator {
  NSFileProviderItemIdentifier _parent;
  OverlookTransport* _transport;
  NSURLSessionTask* _task;
}
- (instancetype)initWithParent:(NSFileProviderItemIdentifier)parent transport:(OverlookTransport*)transport {
  if ((self = [super init])) {
    _parent = [parent copy];
    _transport = transport;
  }
  return self;
}
- (void)invalidate {
  [_task cancel];
  _task = nil;
}
- (void)enumerateItemsForObserver:(id<NSFileProviderEnumerationObserver>)observer startingAtPage:(NSFileProviderPage)page {
  NSString* parent = ([_parent isEqual:NSFileProviderRootContainerItemIdentifier] ||
                      [_parent isEqual:NSFileProviderWorkingSetContainerItemIdentifier]) ? @"root" : _parent;
  NSString* encoded = [parent stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLQueryAllowedCharacterSet];
  _task = [_transport dataRequest:[@"/v1/enumerate?parent=" stringByAppendingString:encoded] completion:^(NSData* data, NSError* error) {
    id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:NSArray.class]) {
      [observer finishEnumeratingWithError:error ?: Unavailable()];
      return;
    }
    NSMutableArray* items = [NSMutableArray array];
    for (id entry in value) {
      OverlookProviderItem* item = [entry isKindOfClass:NSDictionary.class] ? [OverlookProviderItem itemFromDictionary:entry] : nil;
      if (item != nil) [items addObject:item];
    }
    [observer didEnumerateItems:items];
    [observer finishEnumeratingUpToPage:nil];
  }];
}
@end

@interface OverlookFileProviderExtension : NSObject <NSFileProviderReplicatedExtension>
@end

@implementation OverlookFileProviderExtension {
  NSFileProviderDomain* _domain;
  OverlookTransport* _transport;
}
- (instancetype)initWithDomain:(NSFileProviderDomain*)domain {
  if ((self = [super init])) {
    _domain = domain;
    _transport = [[OverlookTransport alloc] init];
  }
  return self;
}
- (void)invalidate {}
- (nullable id<NSFileProviderEnumerator>)enumeratorForContainerItemIdentifier:(NSFileProviderItemIdentifier)identifier request:(NSFileProviderRequest*)request error:(NSError**)error {
  return [[OverlookEnumerator alloc] initWithParent:identifier transport:_transport];
}
- (NSProgress*)itemForIdentifier:(NSFileProviderItemIdentifier)identifier request:(NSFileProviderRequest*)request completionHandler:(void (^)(NSFileProviderItem, NSError*))completionHandler {
  NSProgress* progress = [NSProgress progressWithTotalUnitCount:1];
  if ([identifier isEqual:NSFileProviderRootContainerItemIdentifier]) {
    completionHandler([OverlookProviderItem itemFromDictionary:@{@"id": @"root", @"parentId": @"root", @"name": _domain.displayName, @"contentType": @"public.folder", @"size": @0, @"dataless": @NO, @"modifiedAt": @"1970-01-01T00:00:00.000Z"}], nil);
    return progress;
  }
  NSString* encoded = [identifier stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLQueryAllowedCharacterSet];
  NSURLSessionTask* task = [_transport dataRequest:[@"/v1/item?id=" stringByAppendingString:encoded] completion:^(NSData* data, NSError* error) {
    id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    OverlookProviderItem* item = [value isKindOfClass:NSDictionary.class] ? [OverlookProviderItem itemFromDictionary:value] : nil;
    completionHandler(item, error ?: (item == nil ? Unavailable() : nil));
  }];
  progress.cancellationHandler = ^{ [task cancel]; };
  return progress;
}
- (NSProgress*)fetchContentsForItemWithIdentifier:(NSFileProviderItemIdentifier)identifier version:(NSFileProviderItemVersion*)version request:(NSFileProviderRequest*)request completionHandler:(void (^)(NSURL*, NSFileProviderItem, NSError*))completionHandler {
  NSProgress* progress = [NSProgress progressWithTotalUnitCount:1];
  __block NSProgress* itemProgress = nil;
  NSURLSessionTask* task = [_transport downloadItem:identifier completion:^(NSURL* location, NSError* error) {
    if (location == nil) {
      completionHandler(nil, nil, error ?: Unavailable());
      return;
    }
    if (progress.cancelled) {
      [NSFileManager.defaultManager removeItemAtURL:location error:nil];
      completionHandler(nil, nil, [NSError errorWithDomain:NSCocoaErrorDomain code:NSUserCancelledError userInfo:nil]);
      return;
    }
    NSError* directoryError = nil;
    NSURL* directory = [[NSFileProviderManager managerForDomain:_domain] temporaryDirectoryURLWithError:&directoryError];
    NSURL* destination = [directory URLByAppendingPathComponent:NSUUID.UUID.UUIDString];
    if (directory == nil || ![NSFileManager.defaultManager moveItemAtURL:location toURL:destination error:&directoryError]) {
      [NSFileManager.defaultManager removeItemAtURL:location error:nil];
      completionHandler(nil, nil, directoryError ?: Unavailable());
      return;
    }
    itemProgress = [self itemForIdentifier:identifier request:request completionHandler:^(NSFileProviderItem item, NSError* itemError) {
      if (itemError != nil || progress.cancelled) {
        [NSFileManager.defaultManager removeItemAtURL:destination error:nil];
        NSError* finalError = itemError ?: [NSError errorWithDomain:NSCocoaErrorDomain code:NSUserCancelledError userInfo:nil];
        completionHandler(nil, nil, finalError);
        return;
      }
      completionHandler(destination, item, nil);
    }];
    if (progress.cancelled) [itemProgress cancel];
  }];
  progress.cancellationHandler = ^{
    [task cancel];
    [itemProgress cancel];
  };
  return progress;
}
- (NSProgress*)createItemBasedOnTemplate:(NSFileProviderItem)itemTemplate fields:(NSFileProviderItemFields)fields contents:(NSURL*)url options:(NSFileProviderCreateItemOptions)options request:(NSFileProviderRequest*)request completionHandler:(void (^)(NSFileProviderItem, NSFileProviderItemFields, BOOL, NSError*))completionHandler {
  completionHandler(nil, fields, NO, ReadOnly());
  return [NSProgress progressWithTotalUnitCount:0];
}
- (NSProgress*)modifyItem:(NSFileProviderItem)item baseVersion:(NSFileProviderItemVersion*)version changedFields:(NSFileProviderItemFields)changedFields contents:(NSURL*)newContents options:(NSFileProviderModifyItemOptions)options request:(NSFileProviderRequest*)request completionHandler:(void (^)(NSFileProviderItem, NSFileProviderItemFields, BOOL, NSError*))completionHandler {
  completionHandler(nil, changedFields, NO, ReadOnly());
  return [NSProgress progressWithTotalUnitCount:0];
}
- (NSProgress*)deleteItemWithIdentifier:(NSFileProviderItemIdentifier)identifier baseVersion:(NSFileProviderItemVersion*)version options:(NSFileProviderDeleteItemOptions)options request:(NSFileProviderRequest*)request completionHandler:(void (^)(NSError*))completionHandler {
  completionHandler(ReadOnly());
  return [NSProgress progressWithTotalUnitCount:0];
}
@end

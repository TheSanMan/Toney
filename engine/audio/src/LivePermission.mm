#include "Protocol.h"
#import <AVFoundation/AVFoundation.h>
#include <condition_variable>
#include <mutex>
#include <chrono>

namespace toney
{
void requestLiveInputPermission()
{
    const auto status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusAuthorized) return;
    if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted)
        throw ControlError("LIVE_PERMISSION_DENIED", "Allow Toney in System Settings → Privacy & Security → Microphone, then restart monitoring.");
    struct Consent { std::mutex mutex; std::condition_variable ready; bool done = false, granted = false; };
    auto consent = std::make_shared<Consent>();
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        {
            std::lock_guard<std::mutex> lock(consent->mutex);
            consent->granted = granted; consent->done = true;
        }
        consent->ready.notify_one();
    }];
    // Control thread only. Stop/desktop exit can kill the helper during consent.
    std::unique_lock<std::mutex> lock(consent->mutex);
    if (!consent->ready.wait_for(lock, std::chrono::seconds(25), [&] { return consent->done; }))
        throw ControlError("LIVE_PERMISSION_TIMEOUT", "Microphone permission was not completed. Allow access and press Start again.");
    if (!consent->granted)
        throw ControlError("LIVE_PERMISSION_DENIED", "Microphone access was denied. Allow Toney in System Settings → Privacy & Security → Microphone.");
}
}

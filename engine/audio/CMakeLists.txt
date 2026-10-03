cmake_minimum_required(VERSION 3.22)
project(ToneyEngine VERSION 0.6.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
include(cmake/NamCore.cmake)

set(JUCE_PATH "" CACHE PATH "Optional checkout of official JUCE 8.0.14")
if(JUCE_PATH)
  add_subdirectory("${JUCE_PATH}" "${CMAKE_BINARY_DIR}/juce" EXCLUDE_FROM_ALL)
else()
  include(FetchContent)
  FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.14
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(JUCE)
endif()

add_library(toney-engine-control STATIC
  src/JsonSyntax.cpp
  src/Protocol.cpp
  src/ToneValidation.cpp
  src/EffectProcessing.cpp
  src/AudioRender.cpp
  src/WaveFiles.cpp
  src/Assets.cpp
  src/ImpulseProcessing.cpp
  src/Resampling.cpp
  src/NamValidation.cpp
  src/NamProcessing.cpp
  src/RealtimeProcessing.cpp
  src/LiveSession.cpp
  src/DeviceInventory.cpp)
target_include_directories(toney-engine-control PUBLIC src "${JUCE_SOURCE_DIR}/modules")
if(APPLE)
  target_sources(toney-engine-control PRIVATE src/LivePermission.mm)
  target_link_libraries(toney-engine-control PRIVATE "-framework AVFoundation")
endif()
target_link_libraries(toney-engine-control PRIVATE juce::juce_audio_devices juce::juce_audio_formats juce::juce_dsp juce::juce_cryptography PUBLIC toney-nam-core)
target_compile_definitions(toney-engine-control PUBLIC
  JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
  JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0
  JUCE_USE_FLAC=0 JUCE_USE_OGGVORBIS=0 JUCE_USE_MP3AUDIOFORMAT=0
  JUCE_APPLICATION_NAME_STRING="ToneyEngine"
  JUCE_APPLICATION_VERSION_STRING="0.6.0")

add_executable(toney-engine src/Main.cpp)
target_link_libraries(toney-engine PRIVATE toney-engine-control)
set_target_properties(toney-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
if(APPLE)
  # TCC may attribute microphone access to the bundled helper itself.
  target_link_options(toney-engine PRIVATE "LINKER:-sectcreate,__TEXT,__info_plist,${CMAKE_CURRENT_SOURCE_DIR}/resources/Info.plist")
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(toney-engine-tests tests/ControlTests.cpp)
  target_link_libraries(toney-engine-tests PRIVATE toney-engine-control)
  add_test(NAME native-control-contract COMMAND toney-engine-tests)
  add_executable(toney-render-tests tests/RenderTests.cpp)
  target_link_libraries(toney-render-tests PRIVATE toney-engine-control)
  add_test(NAME native-offline-render COMMAND toney-render-tests)
  add_executable(toney-asset-tests tests/AssetTests.cpp)
  target_link_libraries(toney-asset-tests PRIVATE toney-engine-control)
  add_test(NAME native-assets COMMAND toney-asset-tests)
  add_executable(toney-nam-tests tests/NamTests.cpp)
  target_link_libraries(toney-nam-tests PRIVATE toney-engine-control)
  target_compile_definitions(toney-nam-tests PRIVATE TONEY_NAM_FIXTURES="${TONEY_NAM_SOURCE}/example_models")
  add_test(NAME native-neural-models COMMAND toney-nam-tests)
  add_executable(toney-live-tests tests/RealtimeTests.cpp)
  target_link_libraries(toney-live-tests PRIVATE toney-engine-control)
  target_compile_definitions(toney-live-tests PRIVATE TONEY_NAM_FIXTURES="${TONEY_NAM_SOURCE}/example_models")
  add_test(NAME native-live-audio COMMAND toney-live-tests)
endif()

cmake_minimum_required(VERSION 3.22)
project(ToneyEngine VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

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
  src/DeviceInventory.cpp)
target_include_directories(toney-engine-control PUBLIC src "${JUCE_SOURCE_DIR}/modules")
target_link_libraries(toney-engine-control PRIVATE juce::juce_audio_devices)
target_compile_definitions(toney-engine-control PUBLIC
  JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
  JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0
  JUCE_APPLICATION_NAME_STRING="ToneyEngine"
  JUCE_APPLICATION_VERSION_STRING="0.2.0")

add_executable(toney-engine src/Main.cpp)
target_link_libraries(toney-engine PRIVATE toney-engine-control)
set_target_properties(toney-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

include(CTest)
if(BUILD_TESTING)
  add_executable(toney-engine-tests tests/ControlTests.cpp)
  target_link_libraries(toney-engine-tests PRIVATE toney-engine-control)
  add_test(NAME native-control-contract COMMAND toney-engine-tests)
endif()

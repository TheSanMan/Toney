# Official classic mono NAM core. All source/dependency revisions are immutable.
include(FetchContent)
set(TONEY_NAM_COMMIT e5cc355746866bed85cd48ab3e92513dc8cf7a8b)
set(TONEY_EIGEN_COMMIT 87300c93cae6a8afd9a4f8aa8d9d5c5324cf02e1)
set(NAM_PATH "" CACHE PATH "Existing official NeuralAmpModelerCore checkout at the pinned commit")
if(NAM_PATH)
  execute_process(COMMAND git -C "${NAM_PATH}" rev-parse HEAD
    OUTPUT_VARIABLE _nam_revision OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE _nam_git_status)
  if(NOT _nam_git_status EQUAL 0 OR NOT _nam_revision STREQUAL TONEY_NAM_COMMIT)
    message(FATAL_ERROR "NAM_PATH must point to official NAM core commit ${TONEY_NAM_COMMIT}")
  endif()
  set(TONEY_NAM_SOURCE "${NAM_PATH}")
else()
  FetchContent_Declare(toney_nam
    GIT_REPOSITORY https://github.com/sdatkinson/NeuralAmpModelerCore.git
    GIT_TAG ${TONEY_NAM_COMMIT}
    GIT_SUBMODULES Dependencies/eigen
    SOURCE_SUBDIR toney-no-upstream-tools)
  FetchContent_MakeAvailable(toney_nam)
  set(TONEY_NAM_SOURCE "${toney_nam_SOURCE_DIR}")
endif()
set(TONEY_EIGEN_SOURCE "${TONEY_NAM_SOURCE}/Dependencies/eigen")
if(NOT EXISTS "${TONEY_EIGEN_SOURCE}/Eigen/Dense")
  message(FATAL_ERROR "Pinned NAM Eigen dependency is missing. Run git submodule update --init Dependencies/eigen in NAM_PATH.")
endif()
execute_process(COMMAND git -C "${TONEY_EIGEN_SOURCE}" rev-parse HEAD
  OUTPUT_VARIABLE _eigen_revision OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE _eigen_git_status)
if(NOT _eigen_git_status EQUAL 0 OR NOT _eigen_revision STREQUAL TONEY_EIGEN_COMMIT)
  message(FATAL_ERROR "NAM Eigen must be pinned at ${TONEY_EIGEN_COMMIT}")
endif()

# Upstream's CMake builds tools rather than a consumable library. Compile only
# the official DSP implementation needed by the two supported architectures.
include("${CMAKE_CURRENT_LIST_DIR}/NamRealtime.cmake")
add_library(toney-nam-core STATIC
  "${TONEY_NAM_ADAPTER}/NAM/activations.cpp"
  "${TONEY_NAM_ADAPTER}/NAM/dsp.cpp"
  "${TONEY_NAM_ADAPTER}/NAM/lstm.cpp"
  "${TONEY_NAM_ADAPTER}/NAM/wavenet.cpp")
target_include_directories(toney-nam-core PUBLIC "${TONEY_NAM_ADAPTER}" "${TONEY_NAM_SOURCE}/Dependencies/nlohmann")
target_include_directories(toney-nam-core SYSTEM PUBLIC "${TONEY_EIGEN_SOURCE}")
target_compile_definitions(toney-nam-core PUBLIC NAM_SAMPLE_FLOAT EIGEN_MPL2_ONLY)
target_compile_features(toney-nam-core PUBLIC cxx_std_17)

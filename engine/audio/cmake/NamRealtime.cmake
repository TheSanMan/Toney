# Keep the immutable upstream checkout untouched. Apply three small allocation
# repairs to a build-local copy, with exact-match guards against upstream drift.
# The original implementation remains attributable to NAM's upstream license.
set(TONEY_NAM_ADAPTER "${CMAKE_BINARY_DIR}/nam-realtime")
file(COPY "${TONEY_NAM_SOURCE}/NAM" DESTINATION "${TONEY_NAM_ADAPTER}")
function(toney_nam_repair filename before after)
  set(path "${TONEY_NAM_ADAPTER}/NAM/${filename}")
  file(READ "${path}" source)
  string(FIND "${source}" "${before}" location)
  if(location EQUAL -1)
    message(FATAL_ERROR "Pinned NAM allocation repair no longer matches ${filename}")
  endif()
  string(REPLACE "${before}" "${after}" source "${source}")
  file(WRITE "${path}" "${source}")
endfunction()
toney_nam_repair(lstm.h
  "Eigen::VectorXf get_hidden_state() const { return this->_xh(Eigen::placeholders::lastN(this->_get_hidden_size())); };"
  "auto get_hidden_state() const { return this->_xh.tail(this->_get_hidden_size()); };")
foreach(filename lstm.h lstm.cpp)
  toney_nam_repair(${filename} "process_(const Eigen::VectorXf& x)" "process_(Eigen::Ref<const Eigen::VectorXf> x)")
endforeach()
toney_nam_repair(lstm.cpp
  "this->_ifgo = this->_w * this->_xh + this->_b;"
  "this->_ifgo.noalias() = this->_w * this->_xh;\n  this->_ifgo += this->_b;")
foreach(filename dsp.h dsp.cpp)
  toney_nam_repair(${filename}
    "process_(const Eigen::MatrixXf& input, const int num_frames)"
    "process_(Eigen::Ref<const Eigen::MatrixXf> input, const int num_frames)")
endforeach()

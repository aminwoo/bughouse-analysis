#!/usr/bin/env python3
"""Writes tiny-fp16.onnx, a small FP16 network for tests/onnxRewrite.test.ts.

It has FP32 inputs and outputs around FP16 internals like the published
hivemind networks, plus an FP16 Constant attribute, an initializer stored in
int32_data and special values (subnormal, max, -0, inf) to exercise the
converter.

    python3 tests/fixtures/make-fp16-model.py tests/fixtures/tiny-fp16.onnx
"""
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

F16 = TensorProto.FLOAT16

weight = numpy_helper.from_array(np.array([0.5, -1.25], dtype=np.float16).reshape(1, 2, 1, 1), "weight")
bias = helper.make_tensor("bias", F16, [1], [2.0], raw=False)  # stored in int32_data
special = np.array([2.0**-24, 2.0**-15, 65504.0, -0.0, np.inf, -3.0], dtype=np.float16)

nodes = [
    helper.make_node("Cast", ["data"], ["data16"], to=F16),
    helper.make_node("Conv", ["data16", "weight", "bias"], ["conv16"]),
    helper.make_node("Constant", [], ["offset16"], value=numpy_helper.from_array(np.array([0.25], dtype=np.float16))),
    helper.make_node("Add", ["conv16", "offset16"], ["sum16"]),
    helper.make_node("Cast", ["sum16"], ["value"], to=TensorProto.FLOAT),
    helper.make_node("Constant", [], ["special16"], value=numpy_helper.from_array(special)),
    helper.make_node("Cast", ["special16"], ["special"], to=TensorProto.FLOAT),
]
graph = helper.make_graph(
    nodes,
    "tiny",
    [helper.make_tensor_value_info("data", TensorProto.FLOAT, ["batch", 2, 2, 2])],
    [
        helper.make_tensor_value_info("value", TensorProto.FLOAT, ["batch", 1, 2, 2]),
        helper.make_tensor_value_info("special", TensorProto.FLOAT, [6]),
    ],
    [weight, bias],
    value_info=[helper.make_tensor_value_info("sum16", F16, ["batch", 1, 2, 2])],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)], ir_version=8)
onnx.checker.check_model(model)
onnx.save(model, sys.argv[1])

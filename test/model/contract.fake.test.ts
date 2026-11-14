import { FakeModel } from "../../src/model/index.js";
import { describeModelContract } from "./contract.js";

describeModelContract("fake", (c) => new FakeModel({ turns: c.fake }));

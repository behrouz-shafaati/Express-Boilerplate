const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

import c_controller from "@core/controller";
import authService from "./service";
import accessCtrl from "@entity/access/controller";
import requestCtrl from "@entity/request/controller";
import userCtrl from "@entity/user/controller";
import roleCtrl from "@entity/role/controller";
import authSchema from "./schema";
import { Request, Response } from "express";
import {
  Auth,
  DisablePreviuosDeviceAuth,
  RegisterPaylod,
  UpdateAccessToken,
  Logout,
  SetNewPasswordByEmailResetType,
} from "./interface";
import { HaveAccessPayload, User } from "@entity/user/interface";
import { Request as RequestEntity } from "@entity/request/interface";
import { Role } from "@entity/role/interface";
import getHeaders from "@/utils/getHeaders";
import { Id } from "@/core/interface";
import verifyCtrl from "../verify/controller";
import hash from "@/utils/hash";

class controller extends c_controller {
  /**
   * constructor function for controller.
   *
   * @remarks
   * This method is part of the userController class extended of the main parent class baseController.
   *
   * @param service - userService
   *
   * @beta
   */
  constructor(service: any) {
    super(service);
  }
  async disablePreviuosDeviceAuth({
    userId,
    deviceUUID,
  }: DisablePreviuosDeviceAuth) {
    await this.updateMany({
      filters: { userId, deviceUUID },
      params: { active: false },
    });
  }
  async saveNewAuth({
    userId,
    accessToken,
    refreshToken,
    deviceUUID,
    platform,
    origin,
    userAgent,
  }: Partial<Auth>) {
    const deviceid: string = deviceUUID as string;
    const id: Id = userId as Id;
    await this.disablePreviuosDeviceAuth({ userId: id, deviceUUID: deviceid });
    await this.create({
      params: {
        userId,
        accessToken,
        refreshToken,
        deviceUUID,
        platform,
        origin,
        userAgent,
      },
    });
  }

  async updateAccessToken({
    userId,
    deviceUUID,
    refreshToken,
    accessToken,
  }: UpdateAccessToken) {
    await this.findOneAndUpdate({
      filters: { userId, deviceUUID, refreshToken, active: true },
      params: { accessToken },
    });
  }

  async auth(req: Request, res: Response) {
    const headers = getHeaders(req);
    const { deviceUUID } = headers;
    if (!deviceUUID)
      return res.status(400).json({
        message: `deviceUUID is required. set in http header request ["Device-Uuid" = <uuid>]`,
      });
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ message: "Username and password are required." });
    const foundUser: User = await userCtrl.findOne({ filters: { email } });
    if (!foundUser) return res.sendStatus(401); //Unauthorized
    // evaluate password
    const match = await bcrypt.compare(password, foundUser.passwordHash);
    if (match) {
      if (!foundUser.emailVerified) {
        try {
          verifyCtrl.sendEmailVerifyCode(email);
          return res.json({ redirect: `/verify-email?email=${email}` });
        } catch (error: any) {
          console.log(error?.message);
          return res.status(400).json({ msg: "Unable to send verify email." });
        }
      }
      // create JWTs
      const accessToken = jwt.sign(
        { userId: foundUser.id },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "15m" }
      );
      const refreshToken = jwt.sign(
        { userId: foundUser.id },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: "30d" }
      );
      // Saving refreshToken with current user
      const { deviceUUID, platform, origin, userAgent } = headers;
      this.saveNewAuth({
        userId: foundUser.id,
        refreshToken,
        accessToken,
        deviceUUID,
        platform,
        origin,
        userAgent,
      });
      res.cookie("jwt", refreshToken, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      const userWithAccesses = await userCtrl.getUserWithAccesses(foundUser.id);
      res.json({ accessToken, user: userWithAccesses });
    } else {
      res.status(401).json({ msg: "Wrong password." });
    }
  }

  async getUserProfileFromAccessToken(req: any, res: Response) {
    const userId = req.userId;
    const foundUser: User = await this.findOne({
      filters: userId,
      populate: "roleIds",
    });
    res.json(foundUser);
  }

  async refreshToken(req: any, res: Response) {
    const headers = getHeaders(req);
    const { deviceUUID } = headers;
    if (!deviceUUID)
      return res.status(400).json({
        message: `deviceUUID is required. set in http header request ["Device-Uuid" = <uuid>]`,
      });
    const cookies = req.cookies;
    if (!cookies?.jwt) return res.sendStatus(401);
    const refreshToken = cookies.jwt;

    const foundAuth: Auth = await this.findOne({
      filters: { refreshToken, deviceUUID, active: true },
    });
    if (!foundAuth) return res.sendStatus(403); //Forbidden
    const user = await userCtrl.findById({ id: foundAuth.userId });
    if (!user) return res.sendStatus(400);
    // evaluate jwt
    jwt.verify(
      refreshToken,
      process.env.REFRESH_TOKEN_SECRET,
      async (err: any, decoded: any) => {
        if (err || user.id !== decoded.userId) return res.sendStatus(403);
        const accessToken = jwt.sign(
          { userId: decoded.userId },
          process.env.ACCESS_TOKEN_SECRET,
          { expiresIn: "15m" }
        );
        if (refreshToken == "") {
          res.status(401).json({ msg: "Your authentication expired." });
        } else {
          this.updateAccessToken({
            userId: user.id,
            deviceUUID,
            refreshToken,
            accessToken,
          });
          const userWithAccesses = await userCtrl.getUserWithAccesses(user.id);
          res.json({ accessToken, user: userWithAccesses });
        }
      }
    );
  }

  async checkingPermissionToDoRequest(
    payload: HaveAccessPayload
  ): Promise<boolean> {
    payload = {
      userId: undefined,
      ...payload,
    };
    const { userId, method, path } = payload;

    let allowed = true;
    const request: RequestEntity = await requestCtrl.findOne({
      filters: { method, path },
    });
    if (!request || !request?.active) allowed = false;

    if (userId === undefined) {
      // user is guest
      const guestRole = await roleCtrl.getRoleBySlug("guest");
      const access = await accessCtrl.haveAccess({
        roleId: guestRole.id,
        requestId: request.id,
      });
      if (access && allowed) return true;
      return false;
    }

    const user: User = await userCtrl.findById({ id: userId });
    if (!user || !user.active) allowed = false;

    for (let i = 0; i < user.roles.length; i++) {
      const role: Role = user.roles[i] as Role;
      if (!role || !role.active) allowed = false;
      if (role.slug === "super_admin") return true;
      const access = await accessCtrl.haveAccess({
        roleId: role.id,
        requestId: request.id,
      });
      if (access && allowed) return true;
    }
    return false;
  }

  async register(payload: RegisterPaylod) {
    if (payload.password !== payload.confirmPassword)
      throw new Error(
        "The password and confirmation password must be the same"
      );
    const notVerifyedUser = userCtrl.isExistUnverifyedUserEmail(payload.email);
    if (notVerifyedUser) return notVerifyedUser;
    const defaultRole = await roleCtrl.getDefaultRole();
    const newUserPayload = {
      roles: [defaultRole.id],
      email: payload.email,
      passwordHash: payload.password,
    };
    try {
      return userCtrl.create({ params: newUserPayload });
    } catch (error: any) {
      console.log(error.message);
    }
  }

  async logout({ userId, deviceUUID }: Logout) {
    try {
      await this.disablePreviuosDeviceAuth({ userId, deviceUUID });
    } catch (error) {
      console.log("987 err:", error);
      throw error;
    }
  }

  async setNewPasswordByEmailReset({
    email,
    password,
    verifyCode,
  }: SetNewPasswordByEmailResetType) {
    const isValidCode = await verifyCtrl.isVerifyCodeValid({
      type: "EMAIL",
      code: verifyCode,
      origin: email,
    });
    if (!isValidCode) throw new Error("Unvalid verify code.");
    await userCtrl.findOneAndUpdate({
      filters: { email },
      params: { passwordHash: await hash(password), emailVerified: true },
    });
  }
}

export default new controller(new authService(authSchema));

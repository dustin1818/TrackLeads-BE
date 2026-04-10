const nodemailer = require("nodemailer");
const { Resend } = require("resend");

let transporterPromise;
let resendClient;

const createPreviewTransporter = async () => {
  const testAccount = await nodemailer.createTestAccount();

  return nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
};

const getResendClient = () => {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  return resendClient;
};

const getPreviewTransporter = async () => {
  if (!transporterPromise) {
    transporterPromise = createPreviewTransporter();
  }

  return transporterPromise;
};

const buildEmailContent = ({ name, otp, expiresInMinutes }) => ({
  subject: "Verify your TrackLeads email",
  text: [
    `Hello ${name},`,
    "",
    `Your TrackLeads verification code is ${otp}.`,
    `It expires in ${expiresInMinutes} minutes.`,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n"),
  html: `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
      <p style="font-size: 16px; margin-bottom: 16px;">Hello ${name},</p>
      <p style="font-size: 16px; line-height: 1.5; margin-bottom: 20px;">
        Your TrackLeads verification code is:
      </p>
      <div style="font-size: 32px; font-weight: 700; letter-spacing: 10px; text-align: center; background: #f3f4f6; border-radius: 14px; padding: 18px 24px; margin-bottom: 20px;">
        ${otp}
      </div>
      <p style="font-size: 14px; color: #4b5563; line-height: 1.5; margin-bottom: 0;">
        This code expires in ${expiresInMinutes} minutes. If you did not request this, you can ignore this email.
      </p>
    </div>
  `,
});

const sendVerificationOtpEmail = async ({
  email,
  name,
  otp,
  expiresInMinutes,
}) => {
  const emailContent = buildEmailContent({ name, otp, expiresInMinutes });
  const resend = getResendClient();
  const from =
    process.env.RESEND_FROM_EMAIL ||
    process.env.EMAIL_FROM ||
    "TrackLeads <onboarding@resend.dev>";

  if (resend) {
    const { data, error } = await resend.emails.send({
      from,
      to: email,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });

    if (error) {
      console.error("Resend email error:", JSON.stringify(error));
      throw new Error(error.message || "Failed to send verification email");
    }

    console.log(`OTP email sent through Resend to ${email}`, data);
    return null;
  }

  const transporter = await getPreviewTransporter();

  const info = await transporter.sendMail({
    from,
    to: email,
    subject: emailContent.subject,
    text: emailContent.text,
    html: emailContent.html,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;

  if (previewUrl) {
    console.log(`OTP email preview for ${email}: ${previewUrl}`);
  }

  return previewUrl;
};

module.exports = {
  sendVerificationOtpEmail,
};

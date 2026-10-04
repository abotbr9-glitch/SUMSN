import Capacitor
import Foundation
import SafariServices
import UIKit

@objc(SumsnNativePlugin)
final class SumsnNativePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "SumsnNativePlugin"
    let jsName = "SumsnNative"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openPayment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sharePdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "impact", returnType: CAPPluginReturnPromise),
    ]

    private let maximumPdfBytes = 25 * 1024 * 1024

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true, "platform": "ios"])
    }

    @objc func openPayment(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let url = allowedPaymentURL(value) else {
            call.reject("Only an approved live TuwaiqPay URL can be opened.", "PAYMENT_URL_REJECTED")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else {
                call.reject("The secure payment window is unavailable.", "PRESENTER_UNAVAILABLE")
                return
            }
            let controller = SFSafariViewController(url: url)
            controller.preferredControlTintColor = UIColor(red: 23 / 255, green: 105 / 255, blue: 1, alpha: 1)
            controller.dismissButtonStyle = .close
            presenter.present(controller, animated: true) {
                call.resolve(["opened": true])
            }
        }
    }

    @objc func sharePdf(_ call: CAPPluginCall) {
        guard let encoded = call.getString("base64") else {
            call.reject("The shipping label is missing.", "PDF_MISSING")
            return
        }
        let payload = encoded.components(separatedBy: ",").last ?? encoded
        guard let data = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters]),
              data.count <= maximumPdfBytes,
              data.starts(with: Data("%PDF".utf8)) else {
            call.reject("The shipping label is not a valid PDF.", "PDF_INVALID")
            return
        }

        let requestedName = call.getString("filename") ?? "SUMSN-shipping-label.pdf"
        let safeName = sanitizedFilename(requestedName)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sumsn-labels", isDirectory: true)
        let fileURL = directory.appendingPathComponent(safeName)

        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        } catch {
            call.reject("The shipping label could not be prepared.", "PDF_WRITE_FAILED", error)
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else {
                try? FileManager.default.removeItem(at: fileURL)
                call.reject("The share sheet is unavailable.", "PRESENTER_UNAVAILABLE")
                return
            }

            let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(
                    x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.maxY - 1,
                    width: 1,
                    height: 1
                )
            }
            activity.completionWithItemsHandler = { _, completed, _, error in
                try? FileManager.default.removeItem(at: fileURL)
                if let error {
                    call.reject("The shipping label could not be shared.", "PDF_SHARE_FAILED", error)
                } else {
                    call.resolve(["completed": completed])
                }
            }
            presenter.present(activity, animated: true)
        }
    }

    @objc func impact(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let generator = UINotificationFeedbackGenerator()
            generator.prepare()
            let success = call.getString("style") != "error"
            generator.notificationOccurred(success ? .success : .error)
            call.resolve()
        }
    }

    @objc func shareText(_ call: CAPPluginCall) {
        guard let text = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty,
              text.count <= 5_000 else {
            call.reject("The quote summary is invalid.", "SHARE_TEXT_INVALID")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else {
                call.reject("The share sheet is unavailable.", "PRESENTER_UNAVAILABLE")
                return
            }
            let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(
                    x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.maxY - 1,
                    width: 1,
                    height: 1
                )
            }
            activity.completionWithItemsHandler = { _, completed, _, error in
                if let error {
                    call.reject("The quote could not be shared.", "SHARE_TEXT_FAILED", error)
                } else {
                    call.resolve(["completed": completed])
                }
            }
            presenter.present(activity, animated: true)
        }
    }

    private func allowedPaymentURL(_ value: String) -> URL? {
        guard let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              components.user == nil,
              components.password == nil,
              components.port == nil || components.port == 443,
              let host = components.host?.lowercased(),
              !host.matchesEnvironmentMarker,
              host == "tuwaiqpay.com.sa" || host.hasSuffix(".tuwaiqpay.com.sa") ||
              host == "hypbill.com" || host.hasSuffix(".hypbill.com") else {
            return nil
        }
        return components.url
    }

    private func sanitizedFilename(_ value: String) -> String {
        let base = value
            .replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
            .prefix(96)
        let filename = base.isEmpty ? "SUMSN-shipping-label.pdf" : String(base)
        return filename.lowercased().hasSuffix(".pdf") ? filename : "\(filename).pdf"
    }
}

private extension String {
    var matchesEnvironmentMarker: Bool {
        range(of: "(^|[.-])(dev|uat|test|sandbox)([.-]|$)", options: .regularExpression) != nil
    }
}

/**
 * A live level meter for the recording state (DESIGN.md section 7): five
 * bars that follow the microphone, so it is obvious the mic is hearing you.
 *
 * Reads the MediaStream voice.ts already holds through an AnalyserNode;
 * nothing is recorded or sent from here. Bars move by transform only, once
 * per frame, and stay still under reduced motion.
 */
import { prefersReducedMotion } from "../ui/motion";

const BARS = 5;
/** Floor so a silent bar is still visible as a bar. */
const MIN_SCALE = 0.18;

export function createWaveformElement(): HTMLElement {
	const wave = document.createElement("span");
	wave.className = "mic-wave";
	wave.setAttribute("aria-hidden", "true");
	wave.hidden = true;
	for (let i = 0; i < BARS; i++) wave.append(document.createElement("span"));
	return wave;
}

export interface Waveform {
	stop(): void;
}

export function startWaveform(stream: MediaStream, wave: HTMLElement): Waveform {
	const bars = [...wave.children] as HTMLElement[];
	wave.hidden = false;

	const reset = () => bars.forEach((bar) => (bar.style.transform = `scaleY(${MIN_SCALE})`));
	reset();

	if (prefersReducedMotion() || typeof AudioContext === "undefined") {
		return { stop: () => (wave.hidden = true) };
	}

	const context = new AudioContext();
	const source = context.createMediaStreamSource(stream);
	const analyser = context.createAnalyser();
	analyser.fftSize = 64;
	analyser.smoothingTimeConstant = 0.7;
	source.connect(analyser);
	const data = new Uint8Array(analyser.frequencyBinCount);

	let frame = 0;
	const draw = () => {
		analyser.getByteFrequencyData(data);
		// Voice sits in the low bins; spread them across the bars, mirrored
		// so the loudest band is in the middle.
		const order = [3, 1, 0, 2, 4];
		bars.forEach((bar, i) => {
			const bin = 1 + (order[i] ?? i) * 2;
			const level = (data[bin] ?? 0) / 255;
			bar.style.transform = `scaleY(${Math.max(MIN_SCALE, Math.min(1, level * 1.35))})`;
		});
		frame = requestAnimationFrame(draw);
	};
	frame = requestAnimationFrame(draw);

	return {
		stop() {
			cancelAnimationFrame(frame);
			source.disconnect();
			void context.close().catch(() => {});
			reset();
			wave.hidden = true;
		},
	};
}

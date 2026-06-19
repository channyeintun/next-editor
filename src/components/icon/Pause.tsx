const PauseIcon = ({ size = 24 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    fill="none"
    viewBox="0 0 24 24"
  >
    <path
      fill="white"
      d="M8.25 5.25A2.25 2.25 0 0 1 10.5 7.5v9a2.25 2.25 0 0 1-4.5 0v-9a2.25 2.25 0 0 1 2.25-2.25m7.5 0A2.25 2.25 0 0 1 18 7.5v9a2.25 2.25 0 0 1-4.5 0v-9a2.25 2.25 0 0 1 2.25-2.25"
    ></path>
  </svg>
);

export default PauseIcon;
